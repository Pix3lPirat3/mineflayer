module.exports = inject

const TITLE_TYPES = new Set(['set_title', 'set_title_json'])
const SUBTITLE_TYPES = new Set(['set_subtitle', 'set_subtitle_json'])
const ACTION_BAR_TYPES = new Set(['action_bar_message', 'action_bar_message_json'])
const LEGACY_TYPES = ['clear', 'reset', 'set_title', 'set_subtitle', 'action_bar_message', 'set_durations', 'set_title_json', 'set_subtitle_json', 'action_bar_message_json']

function inject (bot) {
  const ChatMessage = require('prismarine-chat')(bot.registry)

  bot._client.on('set_title', packet => {
    const type = typeof packet.type === 'number' ? LEGACY_TYPES[packet.type] : packet.type
    if (TITLE_TYPES.has(type)) {
      bot.emit('title', parseText(packet.text), 'title')
    } else if (SUBTITLE_TYPES.has(type)) {
      bot.emit('title', parseText(packet.text), 'subtitle')
    } else if (ACTION_BAR_TYPES.has(type)) {
      bot.emit('actionBar', toChatMessage(packet.text))
    } else if (type === 'set_durations') {
      bot.emit('title_times', packet.fade_in_time, packet.stay_time, packet.fade_out_time)
    } else if (type === 'clear' || type === 'reset') {
      bot.emit('title_clear')
    }
  })

  function parseText (text) {
    if (typeof text !== 'string') return String(text ?? '')
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed === 'string') return parsed
      return ChatMessage.fromNotch(parsed).toString()
    } catch {
      return text
    }
  }

  function toChatMessage (text) {
    if (typeof text === 'string') {
      try {
        return ChatMessage.fromNotch(JSON.parse(text))
      } catch {}
    }
    return ChatMessage.fromNotch(text ?? '')
  }
}
