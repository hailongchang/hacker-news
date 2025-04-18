import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers'
import { podcastTitle } from '@/config'
import { createOpenAI } from '@ai-sdk/openai'
import { synthesize } from '@echristian/edge-tts'
import { generateText } from 'ai'
import { WorkflowEntrypoint } from 'cloudflare:workers'
import { introPrompt, summarizeBlogPrompt, summarizePodcastPrompt, summarizeStoryPrompt } from './prompt'
import { concatAudioFiles, getHackerNewsStory, getHackerNewsTopStories } from './utils'

interface Params {
  today?: string
}

interface Env extends CloudflareEnv {
  OPENAI_BASE_URL: string
  OPENAI_API_KEY: string
  OPENAI_MODEL: string
  OPENAI_MAX_TOKENS: string
  JINA_KEY: string
  MAN_VOICE_ID: string
  WOMAN_VOICE_ID: string
  AUDIO_SPEED: string
  WORKER_ENV: string
  HACKER_NEWS_WORKER_URL: string
  HACKER_NEWS_R2_BUCKET_URL: string
  HACKER_NEWS_WORKFLOW: Workflow
  BROWSER: Fetcher
}

const retryConfig: WorkflowStepConfig = {
  retries: {
    limit: 5,
    delay: '10 seconds',
    backoff: 'exponential',
  },
  timeout: '3 minutes',
}

export class HackerNewsWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    console.info('trigged event: HackerNewsWorkflow', event)

    const runEnv = this.env.WORKER_ENV || 'production'
    const isDev = runEnv !== 'production'
    const breakTime = isDev ? '2 seconds' : '10 seconds'
    const today = event.payload.today || new Date().toISOString().split('T')[0]
    const openai = createOpenAI({
      name: 'openai',
      baseURL: this.env.OPENAI_BASE_URL!,
      headers: {
        Authorization: `Bearer ${this.env.OPENAI_API_KEY!}`,
      },
    })
    const maxTokens = Number.parseInt(this.env.OPENAI_MAX_TOKENS || '4096')

    const stories = await step.do(`get top stories ${today}`, retryConfig, async () => {
      return await getHackerNewsTopStories(today, this.env.JINA_KEY)
    })

    if (!stories.length) {
      throw new Error('no stories found')
    }

    stories.length = Math.min(stories.length, isDev ? 3 : 10)
    console.info('top stories', isDev ? stories : JSON.stringify(stories))

    const allStories: string[] = []
    for (const story of stories) {
      const storyResponse = await step.do(`get story ${story.id}: ${story.title}`, retryConfig, async () => {
        return await getHackerNewsStory(story, maxTokens, this.env.JINA_KEY)
      })

      console.info(`get story ${story.id} content success`)

      const text = await step.do(`summarize story ${story.id}: ${story.title}`, retryConfig, async () => {
        const { text, usage, finishReason } = await generateText({
          model: openai(this.env.OPENAI_MODEL!),
          system: summarizeStoryPrompt,
          prompt: storyResponse,
        })

        console.info(`get story ${story.id} summary success`, { text, usage, finishReason })
        return text
      })

      allStories.push(text)

      await step.sleep('Give AI a break', breakTime)
    }

    const podcastContent = await step.do('create podcast content', retryConfig, async () => {
      const { text, usage, finishReason } = await generateText({
        model: openai(this.env.OPENAI_MODEL!),
        system: summarizePodcastPrompt,
        prompt: allStories.join('\n\n---\n\n'),
        maxTokens,
        maxRetries: 3,
      })

      console.info(`create hacker news podcast content success`, { text, usage, finishReason })

      return text
    })

    console.info('podcast content:\n', isDev ? podcastContent : podcastContent.slice(0, 100))

    await step.sleep('Give AI a break', breakTime)

    const blogContent = await step.do('create blog content', retryConfig, async () => {
      const { text, usage, finishReason } = await generateText({
        model: openai(this.env.OPENAI_MODEL!),
        system: summarizeBlogPrompt,
        prompt: allStories.join('\n\n---\n\n'),
        maxTokens,
        maxRetries: 3,
      })

      console.info(`create hacker news daily blog content success`, { text, usage, finishReason })

      return text
    })

    console.info('blog content:\n', isDev ? blogContent : blogContent.slice(0, 100))

    await step.sleep('Give AI a break', breakTime)

    const introContent = await step.do('create intro content', retryConfig, async () => {
      const { text, usage, finishReason } = await generateText({
        model: openai(this.env.OPENAI_MODEL!),
        system: introPrompt,
        prompt: podcastContent,
        maxRetries: 3,
      })

      console.info(`create intro content success`, { text, usage, finishReason })

      return text
    })

    const contentKey = `content:${runEnv}:hacker-news:${today}` // FIXME: 去除 debug
    const podcastKey = `${today.replaceAll('-', '/')}/${runEnv}/hacker-news-${today}.mp3` // FIXME: 去除 debug

    const conversations = podcastContent.split('\n').filter(Boolean)

    const audioFiles: string[] = []
    for (const [index, conversation] of conversations.entries()) {
      await step.do('create podcast audio', { ...retryConfig, timeout: '5 minutes' }, async () => {
        if (
          !(conversation.startsWith('男') || conversation.startsWith('女'))
          || !conversation.substring(2).trim()
        ) {
          console.warn('conversation is not valid', conversation)
          return conversation
        }

        console.info('create conversation audio', conversation)
        const { audio } = await synthesize({
          text: conversation.substring(2),
          language: 'zh-CN',
          voice: conversation.startsWith('男') ? (this.env.MAN_VOICE_ID || 'zh-CN-YunyangNeural') : (this.env.WOMAN_VOICE_ID || 'zh-CN-XiaoxiaoNeural'),
          rate: this.env.AUDIO_SPEED || '10%',
        })

        if (!audio.size) {
          throw new Error('podcast audio size is 0')
        }

        await this.env.HACKER_NEWS_R2.put(`${podcastKey}-${index}.mp3`, audio)

        const audioFile = `${this.env.HACKER_NEWS_R2_BUCKET_URL}/${podcastKey}-${index}.mp3?t=${Date.now()}`
        audioFiles.push(audioFile)
        return audioFile
      })
    }

    await step.do('concat audio files', retryConfig, async () => {
      if (!this.env.BROWSER) {
        console.warn('browser is not configured, skip concat audio files')
        return
      }

      const blob = await concatAudioFiles(audioFiles, this.env.BROWSER, { workerUrl: this.env.HACKER_NEWS_WORKER_URL })
      await this.env.HACKER_NEWS_R2.put(podcastKey, blob)

      for (const index of audioFiles.keys()) {
        await this.env.HACKER_NEWS_R2.delete(`${podcastKey}-${index}.mp3`)
      }

      return `${this.env.HACKER_NEWS_R2_BUCKET_URL}/${podcastKey}?t=${Date.now()}`
    })

    console.info('save podcast to r2 success')

    await step.do('save content to kv', retryConfig, async () => {
      await this.env.HACKER_NEWS_KV.put(contentKey, JSON.stringify({
        date: today,
        title: `${podcastTitle} ${today}`,
        stories,
        podcastContent,
        blogContent,
        introContent,
        audio: podcastKey,
        updatedAt: Date.now(),
      }))

      return introContent
    })

    console.info('save content to kv success')
  }
}
