/* eslint-env mocha */
// Offline test for the Bedrock abilities plugin: update_abilities exposes the base layer's flags, permission level and
// speeds on bot.abilities; update_adventure_settings exposes bot.adventureSettings. Both fire events.
const assert = require('assert')
const { EventEmitter } = require('events')
const injectAbilities = require('../../lib/bedrock_plugins/abilities')
const { bedrockTestedVersions } = require('../../lib/version')

function makeBot () {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  injectAbilities(bot)
  return bot
}

for (const version of bedrockTestedVersions) {
  describe(`bedrock ${version} abilities plugin`, function () {
    it('exposes abilities from the base layer and fires abilitiesUpdate', function () {
      const bot = makeBot()
      let fired = false
      bot.on('abilitiesUpdate', () => { fired = true })
      bot._client.emit('update_abilities', {
        entity_unique_id: 1n,
        permission_level: 'operator',
        command_permission: 'operator',
        abilities: [{ type: 'base', allowed: { may_fly: true, build: true }, enabled: { flying: false, build: true }, fly_speed: 0.05, vertical_fly_speed: 1, walk_speed: 0.1 }]
      })
      assert.ok(fired)
      assert.strictEqual(bot.abilities.permissionLevel, 'operator')
      assert.strictEqual(bot.abilities.flags.build, true)
      assert.strictEqual(bot.abilities.allowed.may_fly, true)
      assert.strictEqual(bot.abilities.walkSpeed, 0.1)
    })

    it('exposes adventure settings', function () {
      const bot = makeBot()
      let got = null
      bot.on('adventureSettingsUpdate', s => { got = s })
      bot._client.emit('update_adventure_settings', { no_pvm: false, no_mvp: true, immutable_world: false, show_name_tags: true, auto_jump: true })
      assert.ok(got)
      assert.strictEqual(bot.adventureSettings.noMvp, true)
      assert.strictEqual(bot.adventureSettings.autoJump, true)
    })
  })
}
