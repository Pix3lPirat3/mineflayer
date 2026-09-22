const { randomUUID } = require('crypto')
const injectChatPatterns = require('../chat_patterns')

module.exports = inject

const CHAT_TYPES = new Set(['chat', 'whisper', 'announcement'])
const JSON_TYPES = new Set(['json', 'json_whisper', 'json_announcement'])
const ACTION_BAR_TYPES = new Set(['popup', 'jukebox_popup', 'tip'])

function inject (bot, options) {
  const chatLengthLimit = options.chatLengthLimit ?? 256
  const ChatMessage = require('prismarine-chat')(bot.registry)

  injectChatPatterns(bot, {
    ...options,
    defaultChatPatterns: options.defaultChatPatterns ?? false
  })

  bot._client.on('text', packet => {
    const message = toChatMessage(packet)
    const source = packet.source_name ? packet.source_name.replace(/§[0-9A-FK-OR]/gi, '') : null

    if (ACTION_BAR_TYPES.has(packet.type)) {
      bot.emit('message', message, 'game_info', source)
      bot.emit('messagestr', message.toString(), 'game_info', message, source)
      bot.emit('actionBar', message, source)
      return
    }

    const position = CHAT_TYPES.has(packet.type) || JSON_TYPES.has(packet.type) ? 'chat' : 'system'
    bot.emit('message', message, position, source)
    bot.emit('messagestr', message.toString(), position, message, source)
    if (packet.type === 'whisper' || packet.type === 'json_whisper') {
      bot.emit('whisper', source, message.toString(), message.translate, message, null)
    } else if (position === 'chat') {
      bot.emit('chat', source, message.toString(), message.translate, message, null)
    }
  })

  // Bedrock replies to bot.chat('/command') with command_output (not a text packet), so Java-style listeners that wait
  // on 'message'/'messagestr' after a command see nothing unless we surface it. Each output line is a translation key
  // (message_id) plus parameters; render it via prismarine-chat and emit both the Java message events and a raw
  // 'commandOutput' event carrying success_count/output/data for callers that want the structured result.
  bot._client.on('command_output', packet => {
    for (const line of packet.output || []) {
      if (!line || !line.message_id) continue
      const message = ChatMessage.fromNotch({ translate: line.message_id, with: line.parameters || [] })
      bot.emit('message', message, 'system', null)
      bot.emit('messagestr', message.toString(), 'system', message, null)
    }
    bot.emit('commandOutput', {
      successCount: packet.success_count,
      output: packet.output || [],
      data: packet.has_data ? packet.data : null
    })
  })

  function toChatMessage (packet) {
    if (JSON_TYPES.has(packet.type)) {
      try {
        return ChatMessage.fromNotch(JSON.parse(packet.message))
      } catch (error) {
        bot._warn('Received malformed Bedrock JSON chat:', error.message)
      }
    }

    if (packet.type === 'translation' || packet.needs_translation) {
      return ChatMessage.fromNotch({ translate: packet.message, with: packet.parameters || [] })
    }

    return ChatMessage.fromNotch(packet.message)
  }

  function sendPacket (name, packet) {
    if (typeof bot._client.queue === 'function') bot._client.queue(name, packet)
    else bot._client.write(name, packet)
  }

  function send (message) {
    if (message.startsWith('/')) {
      const modernCommandVersion = bot._client.versionGreaterThanOrEqualTo?.('1.21.130') ?? bot.registry.version['>=']('1.21.130')
      sendPacket('command_request', {
        command: message,
        origin: {
          type: 'player',
          uuid: randomUUID(),
          request_id: '',
          player_entity_id: bot._client.entityId ?? 0n
        },
        internal: false,
        version: modernCommandVersion ? 'latest' : 52
      })
      return
    }

    const packet = {
      type: 'chat',
      needs_translation: false,
      category: 'authored',
      source_name: bot.username || bot._client.profile?.name || bot._client.username,
      message,
      xuid: String(bot._client.profile?.xuid ?? ''),
      platform_chat_id: '',
      has_filtered_message: false,
      filtered_message: ''
    }
    // 1.21.130's cereal schema requires three constant enum fields before its
    // string-valued message type. Protocol 923 restored numeric enum encoding.
    if (bot.version === '1.21.130') {
      packet.chat = 'chat'
      packet.whisper = 'whisper'
      packet.announcement = 'announcement'
    }
    sendPacket('text', packet)
  }

  function chatWithHeader (header, message) {
    if (typeof message === 'number') message = message.toString()
    if (typeof message !== 'string') {
      throw new Error('Chat message type must be a string or number: ' + typeof message)
    }

    if (!header && message.startsWith('/')) {
      send(message)
      return
    }

    const lengthLimit = chatLengthLimit - header.length
    if (lengthLimit < 1) throw new Error('Chat header exceeds the configured chat length limit')
    message.split('\n').forEach(subMessage => {
      if (!subMessage) return
      for (let i = 0; i < subMessage.length; i += lengthLimit) {
        send(header + subMessage.substring(i, i + lengthLimit))
      }
    })
  }

  bot.whisper = (username, message) => chatWithHeader(`/tell ${username} `, message)
  bot.chat = message => chatWithHeader('', message)
  bot.tabComplete = async () => {
    throw new Error('tabComplete is not supported on Bedrock Edition')
  }
}
