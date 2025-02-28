import { Context, Dict, h, pick, Session, Universal, valueMap } from '@satorijs/satori'
import { DiscordBot } from './bot'
import * as Discord from './types'

export * from './types'

export const sanitize = (val: string) =>
  val
    .replace(/[\\*_`~|()\[\]]/g, '\\$&')
    .replace(/@everyone/g, () => '\\@everyone')
    .replace(/@here/g, () => '\\@here')

export const decodeUser = (user: Discord.User): Universal.User => ({
  id: user.id,
  name: user.username,
  userId: user.id,
  avatar: user.avatar && `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`,
  username: user.username,
  discriminator: user.discriminator,
  isBot: user.bot || false,
})

export const decodeGuildMember = (member: Partial<Discord.GuildMember>): Universal.GuildMember => ({
  user: member.user && decodeUser(member.user),
  nick: member.nick,
  roles: member.roles,
  joinedAt: member.joined_at && new Date(member.joined_at).valueOf(),
})

export const decodeGuild = (data: Discord.Guild): Universal.Guild => ({
  id: data.id,
  name: data.name,
})

export const decodeChannel = (data: Discord.Channel): Universal.Channel => ({
  id: data.id,
  name: data.name,
  type: data.type === Discord.Channel.Type.DM ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT,
})

export const decodeRole = (role: Discord.Role): Universal.GuildRole => ({
  ...role,
  permissions: BigInt(role.permissions),
})

export const encodeRole = (role: Partial<Universal.GuildRole>): Partial<Discord.Role> => ({
  ...role,
  permissions: role.permissions && '' + role.permissions,
})

export async function decodeMessage(
  bot: DiscordBot,
  data: Discord.Message,
  message: Universal.Message,
  payload: Universal.MessageLike = message,
  details = true,
) {
  const { platform } = bot

  message.id = message.messageId = data.id
  // https://discord.com/developers/docs/reference#message-formatting
  message.content = ''
  if (data.content) {
    message.content = data.content
      .replace(/<@[!&]?(.+?)>/g, (_, id) => {
        if (data.mention_roles.includes(id)) {
          return h('at', { role: id }).toString()
        } else {
          const user = data.mentions?.find(u => u.id === id || `${u.username}#${u.discriminator}` === id)
          return h.at(id, { name: user?.username }).toString()
        }
      })
      .replace(/<a?:(.*):(.+?)>/g, (_, name, id) => {
        const animated = _[1] === 'a'
        return h('face', { id, name, animated, platform }, [
          h.image(`https://cdn.discordapp.com/emojis/${id}.gif?quality=lossless`),
        ]).toString()
      })
      .replace(/@everyone/g, () => h('at', { type: 'all' }).toString())
      .replace(/@here/g, () => h('at', { type: 'here' }).toString())
      .replace(/<#(.+?)>/g, (_, id) => {
        const channel = data.mention_channels?.find(c => c.id === id)
        return h.sharp(id, { name: channel?.name }).toString()
      })
  }

  // embed 的 update event 太阴间了 只有 id embeds channel_id guild_id 四个成员
  if (data.attachments?.length) {
    if (!/\s$/.test(message.content)) message.content += ' '
    message.content += data.attachments.map(v => {
      if (v.height && v.width && v.content_type?.startsWith('image/')) {
        return h('image', {
          url: v.url,
          proxy_url: v.proxy_url,
          file: v.filename,
        })
      } else if (v.height && v.width && v.content_type?.startsWith('video/')) {
        return h('video', {
          url: v.url,
          proxy_url: v.proxy_url,
          file: v.filename,
        })
      } else if (v.content_type?.startsWith('audio/')) {
        return h('record', {
          url: v.url,
          proxy_url: v.proxy_url,
          file: v.filename,
        })
      } else {
        return h('file', {
          url: v.url,
          proxy_url: v.proxy_url,
          file: v.filename,
        })
      }
    }).join('')
  }
  for (const embed of data.embeds) {
    // not using embed types
    // https://discord.com/developers/docs/resources/channel#embed-object-embed-types
    if (embed.image) {
      message.content += h('image', { url: embed.image.url, proxy_url: embed.image.proxy_url })
    }
    if (embed.thumbnail) {
      message.content += h('image', { url: embed.thumbnail.url, proxy_url: embed.thumbnail.proxy_url })
    }
    if (embed.video) {
      message.content += h('video', { url: embed.video.url, proxy_url: embed.video.proxy_url })
    }
  }
  message.elements = h.parse(message.content)
  // 遇到过 cross post 的消息在这里不会传消息 id
  if (details && data.message_reference) {
    const { message_id, channel_id } = data.message_reference
    message.quote = await bot.getMessage(channel_id, message_id)
  }

  if (!payload) return message
  payload.channel = {
    id: data.channel_id,
    type: data.member ? Universal.Channel.Type.TEXT : Universal.Channel.Type.DIRECT,
  }
  payload.user = decodeUser(data.author)
  payload.member = data.member && decodeGuildMember(data.member)
  payload.timestamp = new Date(data.timestamp).valueOf() || Date.now()
  return message
}

export function setupMessageGuildId(session: Session, guildId: string) {
  session.guildId = guildId
  session.isDirect = !guildId
  session.subtype = guildId ? 'group' : 'private'
}

type ReactionEvent = Partial<
  & Discord.Reaction.Event.Add
  & Discord.Reaction.Event.Remove
  & Discord.Reaction.Event.RemoveAll
  & Discord.Reaction.Event.RemoveEmoji>

function setupReaction(session: Session, data: ReactionEvent) {
  session.userId = data.user_id
  session.messageId = data.message_id
  session.guildId = data.guild_id
  session.channelId = data.channel_id
  session.isDirect = !data.guild_id
  session.subtype = data.guild_id ? 'group' : 'private'
  if (!data.emoji) return
  const { id, name } = data.emoji
  session.content = id ? `${name}:${id}` : name
}

export async function adaptSession<C extends Context>(bot: DiscordBot<C>, input: Discord.Gateway.Payload) {
  const session = bot.session()
  session.setInternal('discord', input)
  if (input.t === 'MESSAGE_CREATE') {
    setupMessageGuildId(session, input.d.guild_id)
    if (input.d.webhook_id && !session.isDirect) {
      try {
        // 403 Missing Permissions
        const webhook = await bot.ensureWebhook(input.d.channel_id)
        // koishi's webhook
        if (webhook.id === input.d.webhook_id) return
      } catch (e) { }
    }
    session.type = 'message'
    await decodeMessage(bot, input.d, session.event.message = {}, session.event)
    // dc 情况特殊 可能有 embeds 但是没有消息主体
    // if (!session.content) return
  } else if (input.t === 'MESSAGE_UPDATE') {
    session.type = 'message-updated'
    const message = await bot.internal.getChannelMessage(input.d.channel_id, input.d.id)
    // Unlike creates, message updates may contain only a subset of the full message object payload
    // https://discord.com/developers/docs/topics/gateway-events#message-update
    await decodeMessage(bot, message, session.event.message = {}, session.event)
    const channel = await bot.internal.getChannel(input.d.channel_id)
    setupMessageGuildId(session, channel.guild_id)
    // if (!session.content) return
  } else if (input.t === 'MESSAGE_DELETE') {
    session.type = 'message-deleted'
    session.messageId = input.d.id
    session.channelId = input.d.channel_id
    setupMessageGuildId(session, input.d.guild_id)
  } else if (input.t === 'MESSAGE_REACTION_ADD') {
    session.type = 'reaction-added'
    setupReaction(session, input.d)
  } else if (input.t === 'MESSAGE_REACTION_REMOVE') {
    session.type = 'reaction-deleted'
    session.subtype = 'one'
    setupReaction(session, input.d)
  } else if (input.t === 'MESSAGE_REACTION_REMOVE_ALL') {
    session.type = 'reaction-deleted'
    session.subtype = 'all'
    setupReaction(session, input.d)
  } else if (input.t === 'MESSAGE_REACTION_REMOVE_EMOJI') {
    session.type = 'reaction-deleted'
    session.subtype = 'emoji'
    setupReaction(session, input.d)
  } else if (input.t === 'GUILD_ROLE_CREATE') {
    session.type = 'guild-role-added'
    session.guildId = input.d.guild_id
    session.roleId = input.d.role.id
    session.event.role = decodeRole(input.d.role)
  } else if (input.t === 'GUILD_ROLE_UPDATE') {
    session.type = 'guild-role-updated'
    session.guildId = input.d.guild_id
    session.roleId = input.d.role.id
    session.event.role = decodeRole(input.d.role)
  } else if (input.t === 'GUILD_ROLE_DELETE') {
    session.type = 'guild-role-added'
    session.guildId = input.d.guild_id
    session.roleId = input.d.role_id
  } else if (input.t === 'INTERACTION_CREATE' && input.d.type === Discord.Interaction.Type.APPLICATION_COMMAND) {
    const data = input.d.data as Discord.InteractionData.ApplicationCommand
    const command = bot.commands.find(cmd => cmd.name === data.name)
    if (!command) return
    await bot.internal.createInteractionResponse(input.d.id, input.d.token, {
      type: Discord.Interaction.CallbackType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    })
    session.type = 'interaction/command'
    session.isDirect = !input.d.guild_id
    session.subtype = input.d.guild_id ? 'group' : 'private'
    session.channelId = input.d.channel_id
    session.guildId = input.d.guild_id
    session.userId = session.isDirect ? input.d.user.id : input.d.member.user.id
    session.messageId = input.d.id
    session.content = ''
    session.event.argv = decodeArgv(data, command)
  } else if (input.t === 'INTERACTION_CREATE' && input.d.type === Discord.Interaction.Type.MODAL_SUBMIT) {
    const data = input.d.data as Discord.InteractionData.ModalSubmit
    if (!data.custom_id.startsWith('input') && !data.custom_id.includes(':')) return
    // @ts-ignore
    const user_input = data.components[0].components[0].value
    await bot.internal.createInteractionResponse(input.d.id, input.d.token, {
      type: Discord.Interaction.CallbackType.DEFERRED_UPDATE_MESSAGE,
    })
    session.type = 'interaction/command'
    session.isDirect = !input.d.guild_id
    session.subtype = input.d.guild_id ? 'group' : 'private'
    session.channelId = input.d.channel_id
    session.guildId = input.d.guild_id
    session.userId = session.isDirect ? input.d.user.id : input.d.member.user.id
    session.messageId = input.d.id
    session.content = user_input
  } else if (input.t === 'INTERACTION_CREATE' && input.d.type === Discord.Interaction.Type.MESSAGE_COMPONENT) {
    const id = (input.d.data as Discord.InteractionData.MessageComponent).custom_id
    if (id.startsWith('input') && id.includes(':')) {
      await bot.internal.createInteractionResponse(input.d.id, input.d.token, {
        type: Discord.Interaction.CallbackType.MODAL,
        data: {
          custom_id: id,
          title: 'Input',
          components: [{
            type: Discord.ComponentType.ACTION_ROW,
            components: [{
              custom_id: id,
              type: Discord.ComponentType.TEXT_INPUT,
              label: 'Command',
              value: id.slice(id.indexOf(':') + 1),
              style: 1,
            }],
          }],
        },
      })
    } else {
      await bot.internal.createInteractionResponse(input.d.id, input.d.token, {
        type: Discord.Interaction.CallbackType.DEFERRED_UPDATE_MESSAGE,
      })
    }
    session.type = 'interaction/button'
    session.isDirect = !input.d.guild_id
    session.channelId = input.d.channel_id
    session.guildId = input.d.guild_id
    session.userId = session.isDirect ? input.d.user.id : input.d.member.user.id
    session.messageId = input.d.id
    session.content = ''
    session.event.button = {
      id,
    }
  } else if (input.t === 'CHANNEL_UPDATE') {
    session.type = 'channel-updated'
    session.guildId = input.d.guild_id
    session.subtype = input.d.guild_id ? 'group' : 'private'
    session.channelId = input.d.id
  } else {
    return
  }
  return session
}

const types = {
  text: Discord.ApplicationCommand.OptionType.STRING,
  string: Discord.ApplicationCommand.OptionType.STRING,
  boolean: Discord.ApplicationCommand.OptionType.BOOLEAN,
  number: Discord.ApplicationCommand.OptionType.NUMBER,
  integer: Discord.ApplicationCommand.OptionType.INTEGER,
  posint: Discord.ApplicationCommand.OptionType.INTEGER,
  user: Discord.ApplicationCommand.OptionType.STRING,
  channel: Discord.ApplicationCommand.OptionType.STRING,
  guild: Discord.ApplicationCommand.OptionType.STRING,
}

interface Description {
  name: string
  description: Dict<string>
}

const trimDescription = (source: string) => {
  if (!source || source.length < 96) return source
  return source.slice(0, 93) + '...'
}

const encodeDescription = (object: Description) => ({
  description: trimDescription(object.description[''] || object.name),
  description_localizations: valueMap(pick(object.description, Discord.Locale), trimDescription),
})

export const encodeCommand = (cmd: Universal.Command): Discord.ApplicationCommand.Params.Create => ({
  ...encodeDescription(cmd),
  name: cmd.name,
  type: Discord.ApplicationCommand.Type.CHAT_INPUT,
  options: encodeCommandOptions(cmd),
})

const decodeArgv = (data: Discord.InteractionData.ApplicationCommand, command: Universal.Command) => {
  const result = { name: data.name, arguments: [], options: {} } as Universal.Argv
  for (const argument of command.arguments) {
    const value = data.options?.find(opt => opt.name === argument.name)?.value
    if (value !== undefined) result.arguments.push(value)
  }
  for (const option of command.options) {
    const value = data.options?.find(opt => opt.name === option.name)?.value
    if (value !== undefined) result.options[option.name] = value
  }
  return result
}

export function encodeCommandOptions(cmd: Universal.Command): Discord.ApplicationCommand.Option[] {
  const result: Discord.ApplicationCommand.Option[] = []
  if (cmd.children.length) {
    result.push(...cmd.children.map(child => ({
      name: child.name.slice(cmd.name.length + 1),
      type: child.children.length
        ? Discord.ApplicationCommand.OptionType.SUB_COMMAND_GROUP
        : Discord.ApplicationCommand.OptionType.SUB_COMMAND,
      options: encodeCommandOptions(child),
      description: cmd.description[''] || child.name,
      description_localizations: pick(cmd.description, Discord.Locale),
    })))
  } else {
    // `getGlobalApplicationCommands()` does not return `required` property.
    for (const arg of cmd.arguments) {
      result.push({
        ...encodeDescription(arg),
        name: arg.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
        type: types[arg.type] ?? types.text,
        // required: arg.required ?? false,
      })
    }
    for (const option of cmd.options) {
      result.push({
        ...encodeDescription(option),
        name: option.name.toLowerCase(),
        type: types[option.type] ?? types.text,
        // required: option.required ?? false,
        min_value: option.type === 'posint' ? 1 : undefined,
      })
    }
  }
  return result.sort((a, b) => +b.required - +a.required)
}
