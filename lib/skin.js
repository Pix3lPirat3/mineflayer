'use strict'
// A minimal VALID classic (non-persona) Bedrock skin for OFFLINE logins. minecraft-data's defaultSkin is a PERSONA skin
// (marketplace pieces) that only validates against Xbox auth; PocketMine and PowerNukkitX reject it with
// disconnectionScreen.invalidSkin when auth is off (BDS is lenient and accepts it). An offline bot cannot validate a
// persona skin anyway, so the adapter defaults offline connections to this classic skin - a plain 64x64 RGBA texture
// with geometry.humanoid.custom - which every server accepts. bedrock-protocol (handshake/login.js) merges the
// caller's options.skinData over the default, so this is used only when the caller did not supply their own skin.
const b64 = (buf) => Buffer.from(buf).toString('base64')

function skinTexture (w = 64, h = 64) {
  const px = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    px[i * 4 + 0] = 0xB5
    px[i * 4 + 1] = 0x8B
    px[i * 4 + 2] = 0x6A
    px[i * 4 + 3] = 0xFF // opaque - transparent pixels can trip strict validators
  }
  return px
}

function classicSkin () {
  return {
    SkinId: 'mineflayer.classic.' + Math.random().toString(36).slice(2, 10),
    PlayFabId: '',
    SkinResourcePatch: b64(JSON.stringify({ geometry: { default: 'geometry.humanoid.custom' } })),
    SkinImageWidth: 64,
    SkinImageHeight: 64,
    SkinData: b64(skinTexture(64, 64)),
    AnimatedImageData: [],
    CapeImageWidth: 0,
    CapeImageHeight: 0,
    CapeData: '',
    SkinGeometryData: b64('null'),
    SkinGeometryDataEngineVersion: b64('0.0.0'),
    SkinAnimationData: '',
    CapeId: '',
    ArmSize: 'wide',
    SkinColor: '#0',
    PersonaPieces: [],
    PieceTintColors: [],
    PersonaSkin: false,
    PremiumSkin: false,
    CapeOnClassicSkin: false,
    TrustedSkin: true,
    OverrideSkin: true
  }
}

module.exports = { classicSkin }
