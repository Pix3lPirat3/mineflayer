const { onceWithCleanup } = require('../promise_utils')
const injectChatPatterns = require('../chat_patterns')

module.exports = inject

function inject (bot, options) {
  const CHAT_LENGTH_LIMIT = options.chatLengthLimit ?? (bot.supportFeature('lessCharsInChat') ? 100 : 256)
  let endReason
  bot._client.once('end', (reason) => { endReason = reason })

  const ChatMessage = require('prismarine-chat')(bot.registry)

  injectChatPatterns(bot, options)

  bot._client.on('playerChat', (data) => {
    const message = data.formattedMessage
    const verified = data.verified
    let msg
    if (bot.supportFeature('clientsideChatFormatting')) {
      const parameters = {
        sender: data.senderName ? JSON.parse(data.senderName) : undefined,
        target: data.targetName ? JSON.parse(data.targetName) : undefined,
        content: message ? JSON.parse(message) : { text: data.plainMessage }
      }
      const registryIndex = data.type.chatType != null ? data.type.chatType : data.type
      msg = ChatMessage.fromNetwork(registryIndex, parameters)

      if (data.unsignedContent) {
        msg.unsigned = ChatMessage.fromNetwork(registryIndex, { sender: parameters.sender, target: parameters.target, content: JSON.parse(data.unsignedContent) })
      }
    } else {
      msg = ChatMessage.fromNotch(message)
    }
    bot.emit('message', msg, 'chat', data.sender, verified)
    bot.emit('messagestr', msg.toString(), 'chat', msg, data.sender, verified)
  })

  bot._client.on('systemChat', (data) => {
    const msg = ChatMessage.fromNotch(data.formattedMessage)
    const chatPositions = {
      1: 'system',
      2: 'game_info'
    }
    bot.emit('message', msg, chatPositions[data.positionId], null)
    bot.emit('messagestr', msg.toString(), chatPositions[data.positionId], msg, null)
    if (data.positionId === 2) bot.emit('actionBar', msg, null)
  })

  let send = (message) => bot._client.chat(message)
  if (bot.supportFeature('chatCommandsQueuedToMainThread')) {
    // 1.19.0 rejects a queued command as out-of-order if a chat message overtakes
    // it; a tab_complete reply proves every earlier command has been processed.
    let sendChain = Promise.resolve()
    let commandPending = false
    send = (message) => {
      const isCommand = message.startsWith('/')
      sendChain = sendChain.then(async () => {
        if (!isCommand && commandPending) {
          commandPending = false
          await tabComplete('/', false, false).catch(() => {})
        }
        bot._client.chat(message)
        if (isCommand) commandPending = true
      })
    }
  }

  function chatWithHeader (header, message) {
    if (typeof message === 'number') message = message.toString()
    if (typeof message !== 'string') {
      throw new Error('Chat message type must be a string or number: ' + typeof message)
    }
    // minecraft-protocol only attaches client.chat once the login packet puts it in the play state.
    if (typeof bot._client.chat !== 'function') {
      if (endReason !== undefined) {
        throw new Error(`bot.chat() called after the client disconnected before entering the play state (${endReason})`)
      }
      throw new Error('bot.chat() called before the client entered the play state; wait for the "login" or "spawn" event')
    }

    if (!header && message.startsWith('/')) {
      // Do not try and split a command without a header
      send(message)
      return
    }

    const lengthLimit = CHAT_LENGTH_LIMIT - header.length
    message.split('\n').forEach((subMessage) => {
      if (!subMessage) return
      let i
      let smallMsg
      for (i = 0; i < subMessage.length; i += lengthLimit) {
        smallMsg = header + subMessage.substring(i, i + lengthLimit)
        send(smallMsg)
      }
    })
  }

  async function tabComplete (text, assumeCommand = false, sendBlockInSight = true, timeout = 5000) {
    let position

    if (sendBlockInSight) {
      const block = bot.blockAtCursor()

      if (block) {
        position = block.position
      }
    }

    bot._client.write('tab_complete', {
      text,
      assumeCommand,
      lookedAtBlock: position
    })

    const [packet] = await onceWithCleanup(bot._client, 'tab_complete', { timeout })
    return packet.matches
  }

  bot.whisper = (username, message) => {
    chatWithHeader(`/tell ${username} `, message)
  }
  bot.chat = (message) => {
    chatWithHeader('', message)
  }

  bot.tabComplete = tabComplete
}
