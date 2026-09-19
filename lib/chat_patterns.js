// Chat pattern matching and message awaiting, shared by the Java and Bedrock chat plugins: the packet
// handling differs per edition, the pattern API on top of the messagestr event does not.
const USERNAME_REGEX = '(?:\\(.{1,15}\\)|\\[.{1,15}\\]|.){0,5}?(\\w+)'
const LEGACY_VANILLA_CHAT_REGEX = new RegExp(`^${USERNAME_REGEX}\\s?[>:\\-»\\]\\)~]+\\s(.*)$`)

module.exports = injectChatPatterns

function injectChatPatterns (bot, options) {
  const defaultChatPatterns = options.defaultChatPatterns ?? true
  // chat.pattern.type will emit an event for bot.on() of the same type, eg chatType = whisper will trigger bot.on('whisper')
  const _patterns = {}
  let _length = 0
  // deprecated
  bot.chatAddPattern = (patternValue, typeValue) => {
    return bot.addChatPattern(typeValue, patternValue, { deprecated: true })
  }

  bot.addChatPatternSet = (name, patterns, opts = {}) => {
    if (!patterns.every(p => p instanceof RegExp)) throw new Error('Pattern parameter should be of type RegExp')
    const { repeat = true, parse = false } = opts
    _patterns[_length++] = {
      name,
      patterns,
      position: 0,
      matches: [],
      messages: [],
      repeat,
      parse
    }
    return _length
  }

  bot.addChatPattern = (name, pattern, opts = {}) => {
    if (!(pattern instanceof RegExp)) throw new Error('Pattern parameter should be of type RegExp')
    const { repeat = true, deprecated = false, parse = false } = opts
    _patterns[_length] = {
      name,
      patterns: [pattern],
      position: 0,
      matches: [],
      messages: [],
      deprecated,
      repeat,
      parse
    }
    return _length++ // increment length after we give it back to the user
  }

  bot.removeChatPattern = name => {
    if (typeof name === 'number') {
      _patterns[name] = undefined
    } else {
      const matchingPatterns = Object.entries(_patterns).filter(pattern => pattern[1]?.name === name)
      matchingPatterns.forEach(([indexString]) => {
        _patterns[+indexString] = undefined
      })
    }
  }

  function findMatchingPatterns (msg) {
    const found = []
    for (const [indexString, pattern] of Object.entries(_patterns)) {
      if (!pattern) continue
      const { position, patterns } = pattern
      if (patterns[position].test(msg)) {
        found.push(+indexString)
      }
    }
    return found
  }

  bot.on('messagestr', (msg, _, originalMsg) => {
    const foundPatterns = findMatchingPatterns(msg)

    for (const ix of foundPatterns) {
      _patterns[ix].matches.push(msg)
      _patterns[ix].messages.push(originalMsg)
      _patterns[ix].position++

      if (_patterns[ix].deprecated) {
        const [, ...matches] = _patterns[ix].matches[0].match(_patterns[ix].patterns[0])
        bot.emit(_patterns[ix].name, ...matches, _patterns[ix].messages[0].translate, ..._patterns[ix].messages)
        _patterns[ix].messages = [] // clear out old messages
      } else { // regular parsing
        if (_patterns[ix].patterns.length > _patterns[ix].matches.length) return // we have all the matches, so we can emit the done event
        if (_patterns[ix].parse) {
          const matches = _patterns[ix].patterns.map((pattern, i) => {
            const [, ...matches] = _patterns[ix].matches[i].match(pattern) // delete full message match
            return matches
          })
          bot.emit(`chat:${_patterns[ix].name}`, matches)
        } else {
          bot.emit(`chat:${_patterns[ix].name}`, _patterns[ix].matches)
        }
        // these are possibly null-ish if the user deletes them as soon as the event for the match is emitted
      }
      if (_patterns[ix]?.repeat) {
        _patterns[ix].position = 0
        _patterns[ix].matches = []
      } else {
        _patterns[ix] = undefined
      }
    }
  })

  function addDefaultPatterns () {
    // 1.19 changes the chat format to move <sender> prefix from message contents to a separate field.
    // TODO: new chat lister to handle this
    if (!defaultChatPatterns) return
    bot.addChatPattern('whisper', new RegExp(`^${USERNAME_REGEX} whispers(?: to you)?:? (.*)$`), { deprecated: true })
    bot.addChatPattern('whisper', new RegExp(`^\\[${USERNAME_REGEX} -> \\w+\\s?\\] (.*)$`), { deprecated: true })
    bot.addChatPattern('chat', LEGACY_VANILLA_CHAT_REGEX, { deprecated: true })
  }

  function awaitMessage (...args) {
    const timeout = typeof args[args.length - 1] === 'number' ? args.pop() : 20000
    return new Promise((resolve, reject) => {
      const resolveMessages = args.flatMap(x => x)
      const timeoutHandle = setTimeout(() => {
        bot.off('messagestr', messageListener)
        reject(new Error(`Timeout waiting for message after ${timeout}ms`))
      }, timeout)

      function messageListener (msg) {
        if (resolveMessages.some(x => x instanceof RegExp ? x.test(msg) : msg === x)) {
          clearTimeout(timeoutHandle)
          resolve(msg)
          bot.off('messagestr', messageListener)
        }
      }
      bot.on('messagestr', messageListener)
    })
  }
  bot.awaitMessage = awaitMessage
  addDefaultPatterns()
}
