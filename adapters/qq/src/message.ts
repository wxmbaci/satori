import * as QQ from './types'
import { Context, Dict, h, MessageEncoder, Quester } from '@satorijs/satori'
import { QQBot } from './bot'
import FormData from 'form-data'
import { QQGuildBot } from './bot/guild'
import { Entry } from '@satorijs/server-temp'

export const escapeMarkdown = (val: string) =>
  val
    .replace(/([\\`*_[\*_~`\]\-(#!>])/g, '\\$&')

export class QQGuildMessageEncoder<C extends Context = Context> extends MessageEncoder<C, QQGuildBot<C>> {
  private content: string = ''
  private file: Buffer
  private filename: string
  fileUrl: string
  private passiveId: string
  reference: string
  private retry = false
  private resource: Dict
  // 先文后图
  async flush() {
    if (!this.content.trim().length && !this.file && !this.fileUrl) {
      return
    }
    const isDirect = this.channelId.includes('_')

    let endpoint = `/channels/${this.channelId}/messages`
    if (isDirect) endpoint = `/dms/${this.channelId.split('_')[0]}/messages`
    const useFormData = Boolean(this.file)
    let msg_id = this.options?.session?.messageId ?? this.options?.session?.id
    if (this.options?.session && (Date.now() - this.options?.session?.timestamp) > MSG_TIMEOUT) {
      msg_id = null
    }
    if (this.passiveId) msg_id = this.passiveId

    let r: Partial<QQ.Message.Response>
    this.bot.logger.debug('use form data %s', useFormData)
    try {
      if (useFormData) {
        const form = new FormData()
        form.append('content', this.content)
        if (this.options?.session && msg_id) {
          form.append('msg_id', msg_id)
        }
        if (this.file) {
          form.append('file_image', this.file, this.filename)
        }
        // if (this.fileUrl) {
        //   form.append('image', this.fileUrl)
        // }
        r = await this.bot.http.post<QQ.Message>(endpoint, form, {
          headers: form.getHeaders(),
        })
      } else {
        r = await this.bot.http.post<QQ.Message>(endpoint, {
          ...{
            content: this.content,
            msg_id,
            image: this.fileUrl,
          },
          ...(this.reference ? {
            message_reference: {
              message_id: this.reference,
            },
          } : {}),
        })
      }
    } catch (e) {
      this.bot.logger.error(e)
      this.bot.logger.error('[response] %o', e.response?.data)
      if ((e.repsonse?.data?.code === 40004 || e.response?.data?.code === 102) && !this.retry && this.fileUrl) {
        this.bot.logger.warn('retry image sending')
        this.retry = true
        await this.resolveFile(null, true)
        await this.flush()
      }
    }

    this.bot.logger.debug(r)
    const session = this.bot.session()
    session.type = 'send'
    // await decodeMessage(this.bot, r, session.event.message = {}, session.event)
    if (isDirect) {
      session.guildId = this.session.guildId
      session.channelId = this.channelId
      session.isDirect = true
    }

    // https://bot.q.qq.com/wiki/develop/api/gateway/direct_message.html#%E6%B3%A8%E6%84%8F
    /**
     * active msg, http 202: {"code":304023,"message":"push message is waiting for audit now","data":{"message_audit":{"audit_id":"xxx"}}}
     * passive msg, http 200: Partial<QQ.Message>
     */
    if (r.id) {
      session.messageId = r.id
      session.app.emit(session, 'send', session)
      this.results.push(session.event.message)
    } else if (r.code === 304023 && this.bot.config.parent.intents & QQ.Intents.MESSAGE_AUDIT) {
      try {
        const auditData: QQ.MessageAudited = await this.audit(r.data.message_audit.audit_id)
        session.messageId = auditData.message_id
        session.app.emit(session, 'send', session)
        this.results.push(session.event.message)
      } catch (e) {
        this.bot.logger.error(e)
      }
    }
    this.content = ''
    this.file = null
    this.filename = null
    this.fileUrl = null
    this.resource = null
    this.retry = false
  }

  async audit(audit_id: string): Promise<QQ.MessageAudited> {
    return new Promise((resolve, reject) => {
      const dispose = this.bot.ctx.on('qq/message-audit-pass', (data) => {
        if (data.audit_id === audit_id) {
          dispose()
          dispose2()
          resolve(data)
        }
      })
      const dispose2 = this.bot.ctx.on('qq/message-audit-reject', (data) => {
        if (data.audit_id === audit_id) {
          dispose()
          dispose2()
          reject(data)
        }
      })
    })
  }

  async resolveFile(attrs: Dict, download = false) {
    if (attrs) this.resource = attrs
    if (!download && !await this.bot.ctx.http.isPrivate(this.resource.url)) {
      return this.fileUrl = this.resource.url
    }
    const { data, filename } = await this.bot.ctx.http.file(this.resource.url, this.resource)
    this.file = Buffer.from(data)
    this.filename = filename
    this.fileUrl = null
  }

  async visit(element: h) {
    const { type, attrs, children } = element
    if (type === 'text') {
      this.content += attrs.content
    } else if (type === 'at') {
      switch (attrs.type) {
        case 'all':
          this.content += `@everyone`
          break
        default:
          this.content += `<@${attrs.id}>`
      }
    } else if (type === 'br') {
      this.content += '\n'
    } else if (type === 'p') {
      if (!this.content.endsWith('\n')) this.content += '\n'
      await this.render(children)
      if (!this.content.endsWith('\n')) this.content += '\n'
    } else if (type === 'sharp') {
      this.content += `<#${attrs.id}>`
    } else if (type === 'quote') {
      this.reference = attrs.id
      await this.flush()
    } else if (type === 'passive') {
      this.passiveId = attrs.id
    } else if (type === 'image' && attrs.url) {
      await this.flush()
      await this.resolveFile(attrs)
      await this.flush()
    } else if (type === 'message') {
      await this.flush()
      await this.render(children)
      await this.flush()
    } else {
      await this.render(children)
    }
  }
}

const MSG_TIMEOUT = 5 * 60 * 1000 - 2000// 5 mins

export class QQMessageEncoder<C extends Context = Context> extends MessageEncoder<C, QQBot<C>> {
  private content: string = ''
  private passiveId: string
  private passiveSeq: number
  private useMarkdown = false
  private rows: QQ.Button[][] = []
  private attachedFile: QQ.Message.File.Response

  // 先图后文
  async flush() {
    if (!this.content.trim() && !this.rows.flat().length && !this.attachedFile) return
    this.trimButtons()
    let msg_id: string, msg_seq: number
    if (this.options?.session?.messageId && Date.now() - this.options.session.timestamp < MSG_TIMEOUT) {
      this.options.session['seq'] ||= 0
      msg_id = this.options.session.messageId
      msg_seq = ++this.options.session['seq']
    }
    if (this.passiveId) msg_id = this.passiveId
    if (this.passiveSeq) msg_seq = this.passiveSeq
    const data: QQ.Message.Request = {
      content: this.content,
      msg_type: QQ.Message.Type.TEXT,
      msg_id,
      msg_seq,
    }
    if (this.attachedFile) {
      if (!data.content.length) data.content = ' '
      data.media = this.attachedFile
      data.msg_type = QQ.Message.Type.MEDIA
    }

    if (this.useMarkdown) {
      data.msg_type = QQ.Message.Type.MARKDOWN
      delete data.content
      data.markdown = {
        content: escapeMarkdown(this.content) || ' ',
      }
      if (this.rows.length) {
        data.keyboard = {
          content: {
            rows: this.exportButtons(),
          },
        }
      }
    }
    const session = this.bot.session()
    session.type = 'send'
    try {
      if (this.session.isDirect) {
        const { sendResult: { msg_id } } = await this.bot.internal.sendPrivateMessage(this.session.channelId, data)
        session.messageId = msg_id
      } else {
        // FIXME: missing message id
        const resp = await this.bot.internal.sendMessage(this.session.channelId, data)
        if (resp.msg !== 'success') {
          this.bot.logger.warn(resp)
        }
        if (resp.code === 304023 && this.bot.config.intents & QQ.Intents.MESSAGE_AUDIT) {
          try {
            const auditData: QQ.MessageAudited = await this.audit(resp.data.message_audit.audit_id)
            session.messageId = auditData.message_id
            session.app.emit(session, 'send', session)
            this.results.push(session.event.message)
          } catch (e) {
            this.bot.logger.error(e)
          }
        }
      }
    } catch (e) {
      if (!Quester.isAxiosError(e)) throw e
      this.errors.push(e)
      this.bot.logger.warn('[response] %s %o', e.response?.status, e.response?.data)
    }

    // this.results.push(session.event.message)
    // session.app.emit(session, 'send', session)
    this.content = ''
    this.attachedFile = null
    this.rows = []
  }

  async audit(audit_id: string): Promise<QQ.MessageAudited> {
    return new Promise((resolve, reject) => {
      const dispose = this.bot.ctx.on('qq/message-audit-pass', (data) => {
        if (data.audit_id === audit_id) {
          dispose()
          dispose2()
          resolve(data)
        }
      })
      const dispose2 = this.bot.ctx.on('qq/message-audit-reject', (data) => {
        if (data.audit_id === audit_id) {
          dispose()
          dispose2()
          reject(data)
        }
      })
    })
  }

  async sendFile(type: string, attrs: Dict) {
    let url = attrs.url, entry: Entry | undefined
    if (await this.bot.ctx.http.isPrivate(url)) {
      const temp = this.bot.ctx.get('server.temp')
      if (!temp) {
        return this.bot.logger.warn('missing temporary file service, cannot send assets with private url')
      }
      entry = await temp.create(url)
      url = entry.url
    }
    await this.flush()
    let file_type = 0
    if (type === 'image') file_type = 1
    else if (type === 'video') file_type = 2
    else return
    const data: QQ.Message.File.Request = {
      file_type,
      url,
      srv_send_msg: false,
    }
    let res: QQ.Message.File.Response
    try {
      if (this.session.isDirect) {
        res = await this.bot.internal.sendFilePrivate(this.options.session.event.message.user.id, data)
      } else {
        res = await this.bot.internal.sendFileGuild(this.session.guildId, data)
      }
    } catch (e) {
      if (!Quester.isAxiosError(e)) throw e
      this.errors.push(e)
      this.bot.logger.warn('[response] %s %o', e.response?.status, e.response?.data)
    }
    entry?.dispose?.()
    return res
  }

  decodeButton(attrs: Dict, label: string) {
    const result: QQ.Button = {
      id: attrs.id,
      render_data: {
        label,
        visited_label: label,
        style: attrs.class === 'primary' ? 1 : 0,
      },
      action: {
        type: attrs.type === 'input' ? 2
          : (attrs.type === 'link' ? 0 : 1),
        permission: {
          type: 2,
        },
        data: attrs.type === 'input'
          ? attrs.text : attrs.type === 'link'
            ? attrs.href : attrs.id,
      },
    }
    return result
  }

  lastRow() {
    if (!this.rows.length) this.rows.push([])
    let last = this.rows[this.rows.length - 1]
    if (last.length >= 5) {
      this.rows.push([])
      last = this.rows[this.rows.length - 1]
    }
    return last
  }

  trimButtons() {
    if (this.rows.length && this.rows[this.rows.length - 1].length === 0) this.rows.pop()
  }

  exportButtons() {
    return this.rows.map(v => ({
      buttons: v,
    })) as QQ.InlineKeyboardRow[]
  }

  async visit(element: h) {
    const { type, attrs, children } = element
    if (type === 'text') {
      this.content += attrs.content
    } else if (type === 'passive') {
      this.passiveId = attrs.id
      this.passiveSeq = Number(attrs.seq)
    } else if (type === 'image' && attrs.url) {
      await this.flush()
      const data = await this.sendFile(type, attrs)
      if (data) this.attachedFile = data
    } else if (type === 'video' && attrs.url) {
      await this.flush()
      const data = await this.sendFile(type, attrs)
      if (data) this.attachedFile = data
      await this.flush() // text can't send with video
    } else if (type === 'br') {
      this.content += '\n'
    } else if (type === 'p') {
      if (!this.content.endsWith('\n')) this.content += '\n'
      await this.render(children)
      if (!this.content.endsWith('\n')) this.content += '\n'
    } else if (type === 'button-group') {
      this.useMarkdown = true
      this.rows.push([])
      await this.render(children)
      this.rows.push([])
    } else if (type === 'button') {
      this.useMarkdown = true
      const last = this.lastRow()
      last.push(this.decodeButton(attrs, children.join('')))
    } else if (type === 'message') {
      await this.flush()
      await this.render(children)
      await this.flush()
    } else {
      await this.render(children)
    }
  }
}
