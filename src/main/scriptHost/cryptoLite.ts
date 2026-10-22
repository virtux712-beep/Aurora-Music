/**
 * Synchronous md5 / sha1 for the script sandbox, written from the published algorithm descriptions
 * (RFC 1321 / RFC 3174) rather than copied from a library.
 *
 * Why it lives in the sandbox instead of going through the bridge: LX sources compute request
 * signatures *synchronously* (e.g. `utils.crypto.md5("a=1&b=2")` interpolated straight into a URL),
 * so a Promise-returning hash would break them. Everything that cannot be done in a few dozen lines
 * of arithmetic (AES, RSA, HMAC) still goes through the bridge, where Node's crypto does it.
 *
 * `tools/scripts-smoke.ts` checks these against `node:crypto` for several inputs, including
 * multi-byte UTF-8, so a mistake here fails the build instead of silently producing wrong hashes.
 */
export const SCRIPT_HOST_CRYPTO = `
(function () {
  if (globalThis.__auroraHash) return { installed: true, already: true }

  function rotl(x, n) {
    return (x << n) | (x >>> (32 - n))
  }

  function utf8Bytes(text) {
    var out = []
    var value = String(text)
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i)
      if (code < 0x80) {
        out.push(code)
      } else if (code < 0x800) {
        out.push(0xc0 | (code >> 6), 0x80 | (code & 63))
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
        var low = value.charCodeAt(i + 1)
        var point = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        out.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 63), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63))
        i++
      } else {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
      }
    }
    return out
  }

  function utf8FromBytes(bytes) {
    var out = ''
    for (var i = 0; i < bytes.length; i++) {
      var byte = bytes[i]
      if (byte < 0x80) out += String.fromCharCode(byte)
      else if (byte < 0xe0) out += String.fromCharCode(((byte & 31) << 6) | (bytes[++i] & 63))
      else if (byte < 0xf0) out += String.fromCharCode(((byte & 15) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63))
      else {
        var point = ((byte & 7) << 18) | ((bytes[++i] & 63) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63)
        point -= 0x10000
        out += String.fromCharCode(0xd800 + (point >> 10), 0xdc00 + (point & 1023))
      }
    }
    return out
  }

  function hex32(value, littleEndian) {
    var text = ''
    for (var i = 0; i < 4; i++) {
      var shift = littleEndian ? 8 * i : 8 * (3 - i)
      text += ('0' + ((value >>> shift) & 0xff).toString(16)).slice(-2)
    }
    return text
  }

  function md5(text) {
    var message = utf8Bytes(text)
    var bitLength = message.length * 8
    message.push(0x80)
    while (message.length % 64 !== 56) message.push(0)
    var high = Math.floor(bitLength / 4294967296)
    for (var i = 0; i < 4; i++) message.push((bitLength >>> (8 * i)) & 0xff)
    for (var j = 0; j < 4; j++) message.push((high >>> (8 * j)) & 0xff)

    // Round constants: floor(abs(sin(i + 1)) * 2^32), i.e. the formula RFC 1321 lists as a table.
    var constants = []
    var shifts = []
    var shiftTable = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]
    for (var k = 0; k < 64; k++) {
      constants.push(Math.floor(Math.abs(Math.sin(k + 1)) * 4294967296) | 0)
      shifts.push(shiftTable[(k >> 4) * 4 + (k % 4)])
    }

    var h0 = 0x67452301
    var h1 = 0xefcdab89
    var h2 = 0x98badcfe
    var h3 = 0x10325476

    for (var chunk = 0; chunk < message.length; chunk += 64) {
      var words = []
      for (var w = 0; w < 16; w++) {
        var at = chunk + 4 * w
        words.push(message[at] | (message[at + 1] << 8) | (message[at + 2] << 16) | (message[at + 3] << 24))
      }
      var a = h0
      var b = h1
      var c = h2
      var d = h3
      for (var step = 0; step < 64; step++) {
        var f
        var g
        if (step < 16) {
          f = (b & c) | (~b & d)
          g = step
        } else if (step < 32) {
          f = (d & b) | (~d & c)
          g = (5 * step + 1) % 16
        } else if (step < 48) {
          f = b ^ c ^ d
          g = (3 * step + 5) % 16
        } else {
          f = c ^ (b | ~d)
          g = (7 * step) % 16
        }
        var sum = (f + a + constants[step] + words[g]) | 0
        a = d
        d = c
        c = b
        b = (b + rotl(sum, shifts[step])) | 0
      }
      h0 = (h0 + a) | 0
      h1 = (h1 + b) | 0
      h2 = (h2 + c) | 0
      h3 = (h3 + d) | 0
    }

    return hex32(h0, true) + hex32(h1, true) + hex32(h2, true) + hex32(h3, true)
  }

  function sha1(text) {
    var message = utf8Bytes(text)
    var bitLength = message.length * 8
    message.push(0x80)
    while (message.length % 64 !== 56) message.push(0)
    var high = Math.floor(bitLength / 4294967296)
    message.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff)
    message.push((bitLength >>> 24) & 0xff, (bitLength >>> 16) & 0xff, (bitLength >>> 8) & 0xff, bitLength & 0xff)

    var h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]

    for (var chunk = 0; chunk < message.length; chunk += 64) {
      var words = []
      for (var w = 0; w < 16; w++) {
        var at = chunk + 4 * w
        words.push((message[at] << 24) | (message[at + 1] << 16) | (message[at + 2] << 8) | message[at + 3])
      }
      for (var extend = 16; extend < 80; extend++) {
        words.push(rotl(words[extend - 3] ^ words[extend - 8] ^ words[extend - 14] ^ words[extend - 16], 1))
      }
      var a = h[0]
      var b = h[1]
      var c = h[2]
      var d = h[3]
      var e = h[4]
      for (var step = 0; step < 80; step++) {
        var f
        var k
        if (step < 20) {
          f = (b & c) | (~b & d)
          k = 0x5a827999
        } else if (step < 40) {
          f = b ^ c ^ d
          k = 0x6ed9eba1
        } else if (step < 60) {
          f = (b & c) | (b & d) | (c & d)
          k = 0x8f1bbcdc
        } else {
          f = b ^ c ^ d
          k = 0xca62c1d6
        }
        var temp = (rotl(a, 5) + f + e + k + words[step]) | 0
        e = d
        d = c
        c = rotl(b, 30)
        b = a
        a = temp
      }
      h[0] = (h[0] + a) | 0
      h[1] = (h[1] + b) | 0
      h[2] = (h[2] + c) | 0
      h[3] = (h[3] + d) | 0
      h[4] = (h[4] + e) | 0
    }

    var out = ''
    for (var index = 0; index < 5; index++) out += hex32(h[index], false)
    return out
  }

  globalThis.__auroraHash = {
    md5: md5,
    sha1: sha1,
    utf8Bytes: utf8Bytes,
    utf8FromBytes: utf8FromBytes,
  }
  return { installed: true }
})()
`
