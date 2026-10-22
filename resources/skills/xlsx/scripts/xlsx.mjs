import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/jszip/dist/jszip.min.js
var require_jszip_min = __commonJS(function(exports, module) {
  /*!
  
  JSZip v3.10.2 - A JavaScript class for generating and reading zip files
  <http://stuartk.com/jszip>
  
  (c) 2009-2016 Stuart Knightley <stuart [at] stuartk.com>
  Dual licenced under the MIT license or GPLv3. See https://raw.github.com/Stuk/jszip/main/LICENSE.markdown.
  
  JSZip uses the library pako released under the MIT license :
  https://github.com/nodeca/pako/blob/main/LICENSE
  */
  (function(e) {
    if (typeof exports == "object" && typeof module != "undefined")
      module.exports = e();
    else if (typeof define == "function" && define.amd)
      define([], e);
    else {
      (typeof window != "undefined" ? window : typeof global != "undefined" ? global : typeof self != "undefined" ? self : this).JSZip = e();
    }
  })(function() {
    return function s(a, o, h) {
      function u(r, e) {
        if (!o[r]) {
          if (!a[r]) {
            var t = __require;
            if (!e && t)
              return t(r, true);
            if (l)
              return l(r, true);
            var n = new Error("Cannot find module '" + r + "'");
            throw n.code = "MODULE_NOT_FOUND", n;
          }
          var i = o[r] = { exports: {} };
          a[r][0].call(i.exports, function(e) {
            var t = a[r][1][e];
            return u(t || e);
          }, i, i.exports, s, a, o, h);
        }
        return o[r].exports;
      }
      for (var l = __require, e = 0;e < h.length; e++)
        u(h[e]);
      return u;
    }({ 1: [function(e, t, r) {
      var d = e("./utils"), c = e("./support"), p = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
      r.encode = function(e) {
        for (var t, r, n, i, s, a, o, h = [], u = 0, l = e.length, f = l, c = d.getTypeOf(e) !== "string";u < e.length; )
          f = l - u, n = c ? (t = e[u++], r = u < l ? e[u++] : 0, u < l ? e[u++] : 0) : (t = e.charCodeAt(u++), r = u < l ? e.charCodeAt(u++) : 0, u < l ? e.charCodeAt(u++) : 0), i = t >> 2, s = (3 & t) << 4 | r >> 4, a = 1 < f ? (15 & r) << 2 | n >> 6 : 64, o = 2 < f ? 63 & n : 64, h.push(p.charAt(i) + p.charAt(s) + p.charAt(a) + p.charAt(o));
        return h.join("");
      }, r.decode = function(e) {
        var t, r, n, i, s, a, o = 0, h = 0, u = "data:";
        if (e.substr(0, u.length) === u)
          throw new Error("Invalid base64 input, it looks like a data url.");
        var l, f = 3 * (e = e.replace(/[^A-Za-z0-9+/=]/g, "")).length / 4;
        if (e.charAt(e.length - 1) === p.charAt(64) && f--, e.charAt(e.length - 2) === p.charAt(64) && f--, f % 1 != 0)
          throw new Error("Invalid base64 input, bad content length.");
        for (l = c.uint8array ? new Uint8Array(0 | f) : new Array(0 | f);o < e.length; )
          t = p.indexOf(e.charAt(o++)) << 2 | (i = p.indexOf(e.charAt(o++))) >> 4, r = (15 & i) << 4 | (s = p.indexOf(e.charAt(o++))) >> 2, n = (3 & s) << 6 | (a = p.indexOf(e.charAt(o++))), l[h++] = t, s !== 64 && (l[h++] = r), a !== 64 && (l[h++] = n);
        return l;
      };
    }, { "./support": 30, "./utils": 32 }], 2: [function(e, t, r) {
      var n = e("./external"), i = e("./stream/DataWorker"), s = e("./stream/Crc32Probe"), a = e("./stream/DataLengthProbe");
      function o(e, t, r, n, i) {
        this.compressedSize = e, this.uncompressedSize = t, this.crc32 = r, this.compression = n, this.compressedContent = i;
      }
      o.prototype = { getContentWorker: function() {
        var e = new i(n.Promise.resolve(this.compressedContent)).pipe(this.compression.uncompressWorker()).pipe(new a("data_length")), t = this;
        return e.on("end", function() {
          if (this.streamInfo.data_length !== t.uncompressedSize)
            throw new Error("Bug : uncompressed data size mismatch");
        }), e;
      }, getCompressedWorker: function() {
        return new i(n.Promise.resolve(this.compressedContent)).withStreamInfo("compressedSize", this.compressedSize).withStreamInfo("uncompressedSize", this.uncompressedSize).withStreamInfo("crc32", this.crc32).withStreamInfo("compression", this.compression);
      } }, o.createWorkerFrom = function(e, t, r) {
        return e.pipe(new s).pipe(new a("uncompressedSize")).pipe(t.compressWorker(r)).pipe(new a("compressedSize")).withStreamInfo("compression", t);
      }, t.exports = o;
    }, { "./external": 6, "./stream/Crc32Probe": 25, "./stream/DataLengthProbe": 26, "./stream/DataWorker": 27 }], 3: [function(e, t, r) {
      var n = e("./stream/GenericWorker");
      r.STORE = { magic: "\x00\x00", compressWorker: function() {
        return new n("STORE compression");
      }, uncompressWorker: function() {
        return new n("STORE decompression");
      } }, r.DEFLATE = e("./flate");
    }, { "./flate": 7, "./stream/GenericWorker": 28 }], 4: [function(e, t, r) {
      var n = e("./utils");
      var o = function() {
        for (var e, t = [], r = 0;r < 256; r++) {
          e = r;
          for (var n = 0;n < 8; n++)
            e = 1 & e ? 3988292384 ^ e >>> 1 : e >>> 1;
          t[r] = e;
        }
        return t;
      }();
      t.exports = function(e, t) {
        return e !== undefined && e.length ? n.getTypeOf(e) !== "string" ? function(e, t, r, n) {
          var i = o, s = n + r;
          e ^= -1;
          for (var a = n;a < s; a++)
            e = e >>> 8 ^ i[255 & (e ^ t[a])];
          return -1 ^ e;
        }(0 | t, e, e.length, 0) : function(e, t, r, n) {
          var i = o, s = n + r;
          e ^= -1;
          for (var a = n;a < s; a++)
            e = e >>> 8 ^ i[255 & (e ^ t.charCodeAt(a))];
          return -1 ^ e;
        }(0 | t, e, e.length, 0) : 0;
      };
    }, { "./utils": 32 }], 5: [function(e, t, r) {
      r.base64 = false, r.binary = false, r.dir = false, r.createFolders = true, r.date = null, r.compression = null, r.compressionOptions = null, r.comment = null, r.unixPermissions = null, r.dosPermissions = null;
    }, {}], 6: [function(e, t, r) {
      var n = null;
      n = typeof Promise != "undefined" ? Promise : e("lie"), t.exports = { Promise: n };
    }, { lie: 37 }], 7: [function(e, t, r) {
      var n = typeof Uint8Array != "undefined" && typeof Uint16Array != "undefined" && typeof Uint32Array != "undefined", i = e("pako"), s = e("./utils"), a = e("./stream/GenericWorker"), o = n ? "uint8array" : "array";
      function h(e, t) {
        a.call(this, "FlateWorker/" + e), this._pako = null, this._pakoAction = e, this._pakoOptions = t, this.meta = {};
      }
      r.magic = "\b\x00", s.inherits(h, a), h.prototype.processChunk = function(e) {
        this.meta = e.meta, this._pako === null && this._createPako(), this._pako.push(s.transformTo(o, e.data), false);
      }, h.prototype.flush = function() {
        a.prototype.flush.call(this), this._pako === null && this._createPako(), this._pako.push([], true);
      }, h.prototype.cleanUp = function() {
        a.prototype.cleanUp.call(this), this._pako = null;
      }, h.prototype._createPako = function() {
        this._pako = new i[this._pakoAction]({ raw: true, level: this._pakoOptions.level || -1 });
        var t = this;
        this._pako.onData = function(e) {
          t.push({ data: e, meta: t.meta });
        };
      }, r.compressWorker = function(e) {
        return new h("Deflate", e);
      }, r.uncompressWorker = function() {
        return new h("Inflate", {});
      };
    }, { "./stream/GenericWorker": 28, "./utils": 32, pako: 38 }], 8: [function(e, t, r) {
      function A(e, t) {
        var r, n = "";
        for (r = 0;r < t; r++)
          n += String.fromCharCode(255 & e), e >>>= 8;
        return n;
      }
      function n(e, t, r, n, i, s) {
        var a, o, { file: h, compression: u } = e, l = s !== O.utf8encode, f = I.transformTo("string", s(h.name)), c = I.transformTo("string", O.utf8encode(h.name)), d = h.comment, p = I.transformTo("string", s(d)), m = I.transformTo("string", O.utf8encode(d)), _ = c.length !== h.name.length, g = m.length !== d.length, b = "", v = "", y = "", { dir: w, date: k } = h, x = { crc32: 0, compressedSize: 0, uncompressedSize: 0 };
        t && !r || (x.crc32 = e.crc32, x.compressedSize = e.compressedSize, x.uncompressedSize = e.uncompressedSize);
        var S = 0;
        t && (S |= 8), l || !_ && !g || (S |= 2048);
        var z = 0, C = 0;
        w && (z |= 16), i === "UNIX" ? (C = 798, z |= function(e, t) {
          var r = e;
          return e || (r = t ? 16893 : 33204), (65535 & r) << 16;
        }(h.unixPermissions, w)) : (C = 20, z |= function(e) {
          return 63 & (e || 0);
        }(h.dosPermissions)), a = k.getUTCHours(), a <<= 6, a |= k.getUTCMinutes(), a <<= 5, a |= k.getUTCSeconds() / 2, o = k.getUTCFullYear() - 1980, o <<= 4, o |= k.getUTCMonth() + 1, o <<= 5, o |= k.getUTCDate(), _ && (v = A(1, 1) + A(B(f), 4) + c, b += "up" + A(v.length, 2) + v), g && (y = A(1, 1) + A(B(p), 4) + m, b += "uc" + A(y.length, 2) + y);
        var E = "";
        return E += `
\x00`, E += A(S, 2), E += u.magic, E += A(a, 2), E += A(o, 2), E += A(x.crc32, 4), E += A(x.compressedSize, 4), E += A(x.uncompressedSize, 4), E += A(f.length, 2), E += A(b.length, 2), { fileRecord: R.LOCAL_FILE_HEADER + E + f + b, dirRecord: R.CENTRAL_FILE_HEADER + A(C, 2) + E + A(p.length, 2) + "\x00\x00\x00\x00" + A(z, 4) + A(n, 4) + f + b + p };
      }
      var I = e("../utils"), i = e("../stream/GenericWorker"), O = e("../utf8"), B = e("../crc32"), R = e("../signature");
      function s(e, t, r, n) {
        i.call(this, "ZipFileWorker"), this.bytesWritten = 0, this.zipComment = t, this.zipPlatform = r, this.encodeFileName = n, this.streamFiles = e, this.accumulate = false, this.contentBuffer = [], this.dirRecords = [], this.currentSourceOffset = 0, this.entriesCount = 0, this.currentFile = null, this._sources = [];
      }
      I.inherits(s, i), s.prototype.push = function(e) {
        var t = e.meta.percent || 0, r = this.entriesCount, n = this._sources.length;
        this.accumulate ? this.contentBuffer.push(e) : (this.bytesWritten += e.data.length, i.prototype.push.call(this, { data: e.data, meta: { currentFile: this.currentFile, percent: r ? (t + 100 * (r - n - 1)) / r : 100 } }));
      }, s.prototype.openedSource = function(e) {
        this.currentSourceOffset = this.bytesWritten, this.currentFile = e.file.name;
        var t = this.streamFiles && !e.file.dir;
        if (t) {
          var r = n(e, t, false, this.currentSourceOffset, this.zipPlatform, this.encodeFileName);
          this.push({ data: r.fileRecord, meta: { percent: 0 } });
        } else
          this.accumulate = true;
      }, s.prototype.closedSource = function(e) {
        this.accumulate = false;
        var t = this.streamFiles && !e.file.dir, r = n(e, t, true, this.currentSourceOffset, this.zipPlatform, this.encodeFileName);
        if (this.dirRecords.push(r.dirRecord), t)
          this.push({ data: function(e) {
            return R.DATA_DESCRIPTOR + A(e.crc32, 4) + A(e.compressedSize, 4) + A(e.uncompressedSize, 4);
          }(e), meta: { percent: 100 } });
        else
          for (this.push({ data: r.fileRecord, meta: { percent: 0 } });this.contentBuffer.length; )
            this.push(this.contentBuffer.shift());
        this.currentFile = null;
      }, s.prototype.flush = function() {
        for (var e = this.bytesWritten, t = 0;t < this.dirRecords.length; t++)
          this.push({ data: this.dirRecords[t], meta: { percent: 100 } });
        var r = this.bytesWritten - e, n = function(e, t, r, n, i) {
          var s = I.transformTo("string", i(n));
          return R.CENTRAL_DIRECTORY_END + "\x00\x00\x00\x00" + A(e, 2) + A(e, 2) + A(t, 4) + A(r, 4) + A(s.length, 2) + s;
        }(this.dirRecords.length, r, e, this.zipComment, this.encodeFileName);
        this.push({ data: n, meta: { percent: 100 } });
      }, s.prototype.prepareNextSource = function() {
        this.previous = this._sources.shift(), this.openedSource(this.previous.streamInfo), this.isPaused ? this.previous.pause() : this.previous.resume();
      }, s.prototype.registerPrevious = function(e) {
        this._sources.push(e);
        var t = this;
        return e.on("data", function(e) {
          t.processChunk(e);
        }), e.on("end", function() {
          t.closedSource(t.previous.streamInfo), t._sources.length ? t.prepareNextSource() : t.end();
        }), e.on("error", function(e) {
          t.error(e);
        }), this;
      }, s.prototype.resume = function() {
        return !!i.prototype.resume.call(this) && (!this.previous && this._sources.length ? (this.prepareNextSource(), true) : this.previous || this._sources.length || this.generatedError ? undefined : (this.end(), true));
      }, s.prototype.error = function(e) {
        var t = this._sources;
        if (!i.prototype.error.call(this, e))
          return false;
        for (var r = 0;r < t.length; r++)
          try {
            t[r].error(e);
          } catch (e) {}
        return true;
      }, s.prototype.lock = function() {
        i.prototype.lock.call(this);
        for (var e = this._sources, t = 0;t < e.length; t++)
          e[t].lock();
      }, t.exports = s;
    }, { "../crc32": 4, "../signature": 23, "../stream/GenericWorker": 28, "../utf8": 31, "../utils": 32 }], 9: [function(e, t, r) {
      var u = e("../compressions"), n = e("./ZipFileWorker");
      r.generateWorker = function(e, a, t) {
        var o = new n(a.streamFiles, t, a.platform, a.encodeFileName), h = 0;
        try {
          e.forEach(function(e, t) {
            h++;
            var r = function(e, t) {
              var r = e || t, n = u[r];
              if (!n)
                throw new Error(r + " is not a valid compression method !");
              return n;
            }(t.options.compression, a.compression), n = t.options.compressionOptions || a.compressionOptions || {}, { dir: i, date: s } = t;
            t._compressWorker(r, n).withStreamInfo("file", { name: e, dir: i, date: s, comment: t.comment || "", unixPermissions: t.unixPermissions, dosPermissions: t.dosPermissions }).pipe(o);
          }), o.entriesCount = h;
        } catch (e) {
          o.error(e);
        }
        return o;
      };
    }, { "../compressions": 3, "./ZipFileWorker": 8 }], 10: [function(e, t, r) {
      function n() {
        if (!(this instanceof n))
          return new n;
        if (arguments.length)
          throw new Error("The constructor with parameters has been removed in JSZip 3.0, please check the upgrade guide.");
        this.files = Object.create(null), this.comment = null, this.root = "", this.clone = function() {
          var e = new n;
          for (var t in this)
            typeof this[t] != "function" && (e[t] = this[t]);
          return e;
        };
      }
      (n.prototype = e("./object")).loadAsync = e("./load"), n.support = e("./support"), n.defaults = e("./defaults"), n.version = "3.10.2", n.loadAsync = function(e, t) {
        return new n().loadAsync(e, t);
      }, n.external = e("./external"), t.exports = n;
    }, { "./defaults": 5, "./external": 6, "./load": 11, "./object": 15, "./support": 30 }], 11: [function(e, t, r) {
      var u = e("./utils"), i = e("./external"), n = e("./utf8"), s = e("./zipEntries"), a = e("./stream/Crc32Probe"), l = e("./nodejsUtils");
      function f(n) {
        return new i.Promise(function(e, t) {
          var r = n.decompressed.getContentWorker().pipe(new a);
          r.on("error", function(e) {
            t(e);
          }).on("end", function() {
            r.streamInfo.crc32 !== n.decompressed.crc32 ? t(new Error("Corrupted zip : CRC32 mismatch")) : e();
          }).resume();
        });
      }
      t.exports = function(e, o) {
        var h = this;
        return o = u.extend(o || {}, { base64: false, checkCRC32: false, optimizedBinaryString: false, createFolders: false, decodeFileName: n.utf8decode }), l.isNode && l.isStream(e) ? i.Promise.reject(new Error("JSZip can't accept a stream when loading a zip file.")) : u.prepareContent("the loaded zip file", e, true, o.optimizedBinaryString, o.base64).then(function(e) {
          var t = new s(o);
          return t.load(e), t;
        }).then(function(e) {
          var t = [i.Promise.resolve(e)], r = e.files;
          if (o.checkCRC32)
            for (var n = 0;n < r.length; n++)
              t.push(f(r[n]));
          return i.Promise.all(t);
        }).then(function(e) {
          for (var t = e.shift(), r = t.files, n = 0;n < r.length; n++) {
            var i = r[n], s = i.fileNameStr, a = u.resolve(i.fileNameStr);
            h.file(a, i.decompressed, { binary: true, optimizedBinaryString: true, date: i.date, dir: i.dir, comment: i.fileCommentStr.length ? i.fileCommentStr : null, unixPermissions: i.unixPermissions, dosPermissions: i.dosPermissions, createFolders: o.createFolders }), i.dir || (h.file(a).unsafeOriginalName = s);
          }
          return t.zipComment.length && (h.comment = t.zipComment), h;
        });
      };
    }, { "./external": 6, "./nodejsUtils": 14, "./stream/Crc32Probe": 25, "./utf8": 31, "./utils": 32, "./zipEntries": 33 }], 12: [function(e, t, r) {
      var n = e("../utils"), i = e("../stream/GenericWorker");
      function s(e, t) {
        i.call(this, "Nodejs stream input adapter for " + e), this._upstreamEnded = false, this._bindStream(t);
      }
      n.inherits(s, i), s.prototype._bindStream = function(e) {
        var t = this;
        (this._stream = e).pause(), e.on("data", function(e) {
          t.push({ data: e, meta: { percent: 0 } });
        }).on("error", function(e) {
          t.isPaused ? this.generatedError = e : t.error(e);
        }).on("end", function() {
          t.isPaused ? t._upstreamEnded = true : t.end();
        });
      }, s.prototype.pause = function() {
        return !!i.prototype.pause.call(this) && (this._stream.pause(), true);
      }, s.prototype.resume = function() {
        return !!i.prototype.resume.call(this) && (this._upstreamEnded ? this.end() : this._stream.resume(), true);
      }, t.exports = s;
    }, { "../stream/GenericWorker": 28, "../utils": 32 }], 13: [function(e, t, r) {
      var i = e("readable-stream").Readable;
      function n(e, t, r) {
        i.call(this, t), this._helper = e;
        var n = this;
        e.on("data", function(e, t) {
          n.push(e) || n._helper.pause(), r && r(t);
        }).on("error", function(e) {
          n.emit("error", e);
        }).on("end", function() {
          n.push(null);
        });
      }
      e("../utils").inherits(n, i), n.prototype._read = function() {
        this._helper.resume();
      }, t.exports = n;
    }, { "../utils": 32, "readable-stream": 16 }], 14: [function(e, t, r) {
      t.exports = { isNode: typeof Buffer != "undefined", newBufferFrom: function(e, t) {
        if (Buffer.from && Buffer.from !== Uint8Array.from)
          return Buffer.from(e, t);
        if (typeof e == "number")
          throw new Error('The "data" argument must not be a number');
        return new Buffer(e, t);
      }, allocBuffer: function(e) {
        if (Buffer.alloc)
          return Buffer.alloc(e);
        var t = new Buffer(e);
        return t.fill(0), t;
      }, isBuffer: function(e) {
        return Buffer.isBuffer(e);
      }, isStream: function(e) {
        return e && typeof e.on == "function" && typeof e.pause == "function" && typeof e.resume == "function";
      } };
    }, {}], 15: [function(e, t, r) {
      function s(e, t, r) {
        var n, i = u.getTypeOf(t), s = u.extend(r || {}, f);
        s.date = s.date || new Date, s.compression !== null && (s.compression = s.compression.toUpperCase()), typeof s.unixPermissions == "string" && (s.unixPermissions = parseInt(s.unixPermissions, 8)), s.unixPermissions && 16384 & s.unixPermissions && (s.dir = true), s.dosPermissions && 16 & s.dosPermissions && (s.dir = true), s.dir && (e = g(e)), s.createFolders && (n = _(e)) && b.call(this, n, true);
        var a = i === "string" && s.binary === false && s.base64 === false;
        r && r.binary !== undefined || (s.binary = !a), (t instanceof c && t.uncompressedSize === 0 || s.dir || !t || t.length === 0) && (s.base64 = false, s.binary = true, t = "", s.compression = "STORE", i = "string");
        var o = null;
        o = t instanceof c || t instanceof l ? t : p.isNode && p.isStream(t) ? new m(e, t) : u.prepareContent(e, t, s.binary, s.optimizedBinaryString, s.base64);
        var h = new d(e, o, s);
        this.files[e] = h;
      }
      var i = e("./utf8"), u = e("./utils"), l = e("./stream/GenericWorker"), a = e("./stream/StreamHelper"), f = e("./defaults"), c = e("./compressedObject"), d = e("./zipObject"), o = e("./generate"), p = e("./nodejsUtils"), m = e("./nodejs/NodejsStreamInputAdapter"), _ = function(e) {
        e.slice(-1) === "/" && (e = e.substring(0, e.length - 1));
        var t = e.lastIndexOf("/");
        return 0 < t ? e.substring(0, t) : "";
      }, g = function(e) {
        return e.slice(-1) !== "/" && (e += "/"), e;
      }, b = function(e, t) {
        return t = t !== undefined ? t : f.createFolders, e = g(e), this.files[e] || s.call(this, e, null, { dir: true, createFolders: t }), this.files[e];
      };
      function h(e) {
        return Object.prototype.toString.call(e) === "[object RegExp]";
      }
      var n = { load: function() {
        throw new Error("This method has been removed in JSZip 3.0, please check the upgrade guide.");
      }, forEach: function(e) {
        var t, r, n;
        for (t in this.files)
          n = this.files[t], (r = t.slice(this.root.length, t.length)) && t.slice(0, this.root.length) === this.root && e(r, n);
      }, filter: function(r) {
        var n = [];
        return this.forEach(function(e, t) {
          r(e, t) && n.push(t);
        }), n;
      }, file: function(e, t, r) {
        if (arguments.length !== 1)
          return e = this.root + e, s.call(this, e, t, r), this;
        if (h(e)) {
          var n = e;
          return this.filter(function(e, t) {
            return !t.dir && n.test(e);
          });
        }
        var i = this.files[this.root + e];
        return i && !i.dir ? i : null;
      }, folder: function(r) {
        if (!r)
          return this;
        if (h(r))
          return this.filter(function(e, t) {
            return t.dir && r.test(e);
          });
        var e = this.root + r, t = b.call(this, e), n = this.clone();
        return n.root = t.name, n;
      }, remove: function(r) {
        r = this.root + r;
        var e = this.files[r];
        if (e || (r.slice(-1) !== "/" && (r += "/"), e = this.files[r]), e && !e.dir)
          delete this.files[r];
        else
          for (var t = this.filter(function(e, t) {
            return t.name.slice(0, r.length) === r;
          }), n = 0;n < t.length; n++)
            delete this.files[t[n].name];
        return this;
      }, generate: function() {
        throw new Error("This method has been removed in JSZip 3.0, please check the upgrade guide.");
      }, generateInternalStream: function(e) {
        var t, r = {};
        try {
          if ((r = u.extend(e || {}, { streamFiles: false, compression: "STORE", compressionOptions: null, type: "", platform: "DOS", comment: null, mimeType: "application/zip", encodeFileName: i.utf8encode })).type = r.type.toLowerCase(), r.compression = r.compression.toUpperCase(), r.type === "binarystring" && (r.type = "string"), !r.type)
            throw new Error("No output type specified.");
          u.checkSupport(r.type), r.platform !== "darwin" && r.platform !== "freebsd" && r.platform !== "linux" && r.platform !== "sunos" || (r.platform = "UNIX"), r.platform === "win32" && (r.platform = "DOS");
          var n = r.comment || this.comment || "";
          t = o.generateWorker(this, r, n);
        } catch (e) {
          (t = new l("error")).error(e);
        }
        return new a(t, r.type || "string", r.mimeType);
      }, generateAsync: function(e, t) {
        return this.generateInternalStream(e).accumulate(t);
      }, generateNodeStream: function(e, t) {
        return (e = e || {}).type || (e.type = "nodebuffer"), this.generateInternalStream(e).toNodejsStream(t);
      } };
      t.exports = n;
    }, { "./compressedObject": 2, "./defaults": 5, "./generate": 9, "./nodejs/NodejsStreamInputAdapter": 12, "./nodejsUtils": 14, "./stream/GenericWorker": 28, "./stream/StreamHelper": 29, "./utf8": 31, "./utils": 32, "./zipObject": 35 }], 16: [function(e, t, r) {
      t.exports = e("stream");
    }, { stream: undefined }], 17: [function(e, t, r) {
      var n = e("./DataReader");
      function i(e) {
        n.call(this, e);
        for (var t = 0;t < this.data.length; t++)
          e[t] = 255 & e[t];
      }
      e("../utils").inherits(i, n), i.prototype.byteAt = function(e) {
        return this.data[this.zero + e];
      }, i.prototype.lastIndexOfSignature = function(e) {
        for (var t = e.charCodeAt(0), r = e.charCodeAt(1), n = e.charCodeAt(2), i = e.charCodeAt(3), s = this.length - 4;0 <= s; --s)
          if (this.data[s] === t && this.data[s + 1] === r && this.data[s + 2] === n && this.data[s + 3] === i)
            return s - this.zero;
        return -1;
      }, i.prototype.readAndCheckSignature = function(e) {
        var t = e.charCodeAt(0), r = e.charCodeAt(1), n = e.charCodeAt(2), i = e.charCodeAt(3), s = this.readData(4);
        return t === s[0] && r === s[1] && n === s[2] && i === s[3];
      }, i.prototype.readData = function(e) {
        if (this.checkOffset(e), e === 0)
          return [];
        var t = this.data.slice(this.zero + this.index, this.zero + this.index + e);
        return this.index += e, t;
      }, t.exports = i;
    }, { "../utils": 32, "./DataReader": 18 }], 18: [function(e, t, r) {
      var n = e("../utils");
      function i(e) {
        this.data = e, this.length = e.length, this.index = 0, this.zero = 0;
      }
      i.prototype = { checkOffset: function(e) {
        this.checkIndex(this.index + e);
      }, checkIndex: function(e) {
        if (this.length < this.zero + e || e < 0)
          throw new Error("End of data reached (data length = " + this.length + ", asked index = " + e + "). Corrupted zip ?");
      }, setIndex: function(e) {
        this.checkIndex(e), this.index = e;
      }, skip: function(e) {
        this.setIndex(this.index + e);
      }, byteAt: function() {}, readInt: function(e) {
        var t, r = 0;
        for (this.checkOffset(e), t = this.index + e - 1;t >= this.index; t--)
          r = (r << 8) + this.byteAt(t);
        return this.index += e, r;
      }, readString: function(e) {
        return n.transformTo("string", this.readData(e));
      }, readData: function() {}, lastIndexOfSignature: function() {}, readAndCheckSignature: function() {}, readDate: function() {
        var e = this.readInt(4);
        return new Date(Date.UTC(1980 + (e >> 25 & 127), (e >> 21 & 15) - 1, e >> 16 & 31, e >> 11 & 31, e >> 5 & 63, (31 & e) << 1));
      } }, t.exports = i;
    }, { "../utils": 32 }], 19: [function(e, t, r) {
      var n = e("./Uint8ArrayReader");
      function i(e) {
        n.call(this, e);
      }
      e("../utils").inherits(i, n), i.prototype.readData = function(e) {
        this.checkOffset(e);
        var t = this.data.slice(this.zero + this.index, this.zero + this.index + e);
        return this.index += e, t;
      }, t.exports = i;
    }, { "../utils": 32, "./Uint8ArrayReader": 21 }], 20: [function(e, t, r) {
      var n = e("./DataReader");
      function i(e) {
        n.call(this, e);
      }
      e("../utils").inherits(i, n), i.prototype.byteAt = function(e) {
        return this.data.charCodeAt(this.zero + e);
      }, i.prototype.lastIndexOfSignature = function(e) {
        return this.data.lastIndexOf(e) - this.zero;
      }, i.prototype.readAndCheckSignature = function(e) {
        return e === this.readData(4);
      }, i.prototype.readData = function(e) {
        this.checkOffset(e);
        var t = this.data.slice(this.zero + this.index, this.zero + this.index + e);
        return this.index += e, t;
      }, t.exports = i;
    }, { "../utils": 32, "./DataReader": 18 }], 21: [function(e, t, r) {
      var n = e("./ArrayReader");
      function i(e) {
        n.call(this, e);
      }
      e("../utils").inherits(i, n), i.prototype.readData = function(e) {
        if (this.checkOffset(e), e === 0)
          return new Uint8Array(0);
        var t = this.data.subarray(this.zero + this.index, this.zero + this.index + e);
        return this.index += e, t;
      }, t.exports = i;
    }, { "../utils": 32, "./ArrayReader": 17 }], 22: [function(e, t, r) {
      var n = e("../utils"), i = e("../support"), s = e("./ArrayReader"), a = e("./StringReader"), o = e("./NodeBufferReader"), h = e("./Uint8ArrayReader");
      t.exports = function(e) {
        var t = n.getTypeOf(e);
        return n.checkSupport(t), t !== "string" || i.uint8array ? t === "nodebuffer" ? new o(e) : i.uint8array ? new h(n.transformTo("uint8array", e)) : new s(n.transformTo("array", e)) : new a(e);
      };
    }, { "../support": 30, "../utils": 32, "./ArrayReader": 17, "./NodeBufferReader": 19, "./StringReader": 20, "./Uint8ArrayReader": 21 }], 23: [function(e, t, r) {
      r.LOCAL_FILE_HEADER = "PK\x03\x04", r.CENTRAL_FILE_HEADER = "PK\x01\x02", r.CENTRAL_DIRECTORY_END = "PK\x05\x06", r.ZIP64_CENTRAL_DIRECTORY_LOCATOR = "PK\x06\x07", r.ZIP64_CENTRAL_DIRECTORY_END = "PK\x06\x06", r.DATA_DESCRIPTOR = "PK\x07\b";
    }, {}], 24: [function(e, t, r) {
      var n = e("./GenericWorker"), i = e("../utils");
      function s(e) {
        n.call(this, "ConvertWorker to " + e), this.destType = e;
      }
      i.inherits(s, n), s.prototype.processChunk = function(e) {
        this.push({ data: i.transformTo(this.destType, e.data), meta: e.meta });
      }, t.exports = s;
    }, { "../utils": 32, "./GenericWorker": 28 }], 25: [function(e, t, r) {
      var n = e("./GenericWorker"), i = e("../crc32");
      function s() {
        n.call(this, "Crc32Probe"), this.withStreamInfo("crc32", 0);
      }
      e("../utils").inherits(s, n), s.prototype.processChunk = function(e) {
        this.streamInfo.crc32 = i(e.data, this.streamInfo.crc32 || 0), this.push(e);
      }, t.exports = s;
    }, { "../crc32": 4, "../utils": 32, "./GenericWorker": 28 }], 26: [function(e, t, r) {
      var n = e("../utils"), i = e("./GenericWorker");
      function s(e) {
        i.call(this, "DataLengthProbe for " + e), this.propName = e, this.withStreamInfo(e, 0);
      }
      n.inherits(s, i), s.prototype.processChunk = function(e) {
        if (e) {
          var t = this.streamInfo[this.propName] || 0;
          this.streamInfo[this.propName] = t + e.data.length;
        }
        i.prototype.processChunk.call(this, e);
      }, t.exports = s;
    }, { "../utils": 32, "./GenericWorker": 28 }], 27: [function(e, t, r) {
      var n = e("../utils"), i = e("./GenericWorker");
      function s(e) {
        i.call(this, "DataWorker");
        var t = this;
        this.dataIsReady = false, this.index = 0, this.max = 0, this.data = null, this.type = "", this._tickScheduled = false, e.then(function(e) {
          t.dataIsReady = true, t.data = e, t.max = e && e.length || 0, t.type = n.getTypeOf(e), t.isPaused || t._tickAndRepeat();
        }, function(e) {
          t.error(e);
        });
      }
      n.inherits(s, i), s.prototype.cleanUp = function() {
        i.prototype.cleanUp.call(this), this.data = null;
      }, s.prototype.resume = function() {
        return !!i.prototype.resume.call(this) && (!this._tickScheduled && this.dataIsReady && (this._tickScheduled = true, n.delay(this._tickAndRepeat, [], this)), true);
      }, s.prototype._tickAndRepeat = function() {
        this._tickScheduled = false, this.isPaused || this.isFinished || (this._tick(), this.isFinished || (n.delay(this._tickAndRepeat, [], this), this._tickScheduled = true));
      }, s.prototype._tick = function() {
        if (this.isPaused || this.isFinished)
          return false;
        var e = null, t = Math.min(this.max, this.index + 16384);
        if (this.index >= this.max)
          return this.end();
        switch (this.type) {
          case "string":
            e = this.data.substring(this.index, t);
            break;
          case "uint8array":
            e = this.data.subarray(this.index, t);
            break;
          case "array":
          case "nodebuffer":
            e = this.data.slice(this.index, t);
        }
        return this.index = t, this.push({ data: e, meta: { percent: this.max ? this.index / this.max * 100 : 0 } });
      }, t.exports = s;
    }, { "../utils": 32, "./GenericWorker": 28 }], 28: [function(e, t, r) {
      function n(e) {
        this.name = e || "default", this.streamInfo = {}, this.generatedError = null, this.extraStreamInfo = {}, this.isPaused = true, this.isFinished = false, this.isLocked = false, this._listeners = { data: [], end: [], error: [] }, this.previous = null;
      }
      n.prototype = { push: function(e) {
        this.emit("data", e);
      }, end: function() {
        if (this.isFinished)
          return false;
        this.flush();
        try {
          this.emit("end"), this.cleanUp(), this.isFinished = true;
        } catch (e) {
          this.emit("error", e);
        }
        return true;
      }, error: function(e) {
        return !this.isFinished && (this.isPaused ? this.generatedError = e : (this.isFinished = true, this.emit("error", e), this.previous && this.previous.error(e), this.cleanUp()), true);
      }, on: function(e, t) {
        return this._listeners[e].push(t), this;
      }, cleanUp: function() {
        this.streamInfo = this.generatedError = this.extraStreamInfo = null, this._listeners = [];
      }, emit: function(e, t) {
        if (this._listeners[e])
          for (var r = 0;r < this._listeners[e].length; r++)
            this._listeners[e][r].call(this, t);
      }, pipe: function(e) {
        return e.registerPrevious(this);
      }, registerPrevious: function(e) {
        if (this.isLocked)
          throw new Error("The stream '" + this + "' has already been used.");
        this.streamInfo = e.streamInfo, this.mergeStreamInfo(), this.previous = e;
        var t = this;
        return e.on("data", function(e) {
          t.processChunk(e);
        }), e.on("end", function() {
          t.end();
        }), e.on("error", function(e) {
          t.error(e);
        }), this;
      }, pause: function() {
        return !this.isPaused && !this.isFinished && (this.isPaused = true, this.previous && this.previous.pause(), true);
      }, resume: function() {
        if (!this.isPaused || this.isFinished)
          return false;
        var e = this.isPaused = false;
        return this.generatedError && (this.error(this.generatedError), e = true), this.previous && this.previous.resume(), !e;
      }, flush: function() {}, processChunk: function(e) {
        this.push(e);
      }, withStreamInfo: function(e, t) {
        return this.extraStreamInfo[e] = t, this.mergeStreamInfo(), this;
      }, mergeStreamInfo: function() {
        for (var e in this.extraStreamInfo)
          Object.prototype.hasOwnProperty.call(this.extraStreamInfo, e) && (this.streamInfo[e] = this.extraStreamInfo[e]);
      }, lock: function() {
        if (this.isLocked)
          throw new Error("The stream '" + this + "' has already been used.");
        this.isLocked = true, this.previous && this.previous.lock();
      }, toString: function() {
        var e = "Worker " + this.name;
        return this.previous ? this.previous + " -> " + e : e;
      } }, t.exports = n;
    }, {}], 29: [function(e, t, r) {
      var h = e("../utils"), i = e("./ConvertWorker"), s = e("./GenericWorker"), u = e("../base64"), n = e("../support"), a = e("../external"), o = null;
      if (n.nodestream)
        try {
          o = e("../nodejs/NodejsStreamOutputAdapter");
        } catch (e) {}
      function l(e, o) {
        return new a.Promise(function(t, r) {
          var n = [], { _internalType: i, _outputType: s, _mimeType: a } = e;
          e.on("data", function(e, t) {
            n.push(e), o && o(t);
          }).on("error", function(e) {
            n = [], r(e);
          }).on("end", function() {
            try {
              var e = function(e, t, r) {
                switch (e) {
                  case "blob":
                    return h.newBlob(h.transformTo("arraybuffer", t), r);
                  case "base64":
                    return u.encode(t);
                  default:
                    return h.transformTo(e, t);
                }
              }(s, function(e, t) {
                var r, n = 0, i = null, s = 0;
                for (r = 0;r < t.length; r++)
                  s += t[r].length;
                switch (e) {
                  case "string":
                    return t.join("");
                  case "array":
                    return Array.prototype.concat.apply([], t);
                  case "uint8array":
                    for (i = new Uint8Array(s), r = 0;r < t.length; r++)
                      i.set(t[r], n), n += t[r].length;
                    return i;
                  case "nodebuffer":
                    return Buffer.concat(t);
                  default:
                    throw new Error("concat : unsupported type '" + e + "'");
                }
              }(i, n), a);
              t(e);
            } catch (e) {
              r(e);
            }
            n = [];
          }).resume();
        });
      }
      function f(e, t, r) {
        var n = t;
        switch (t) {
          case "blob":
          case "arraybuffer":
            n = "uint8array";
            break;
          case "base64":
            n = "string";
        }
        try {
          this._internalType = n, this._outputType = t, this._mimeType = r, h.checkSupport(n), this._worker = e.pipe(new i(n)), e.lock();
        } catch (e) {
          this._worker = new s("error"), this._worker.error(e);
        }
      }
      f.prototype = { accumulate: function(e) {
        return l(this, e);
      }, on: function(e, t) {
        var r = this;
        return e === "data" ? this._worker.on(e, function(e) {
          t.call(r, e.data, e.meta);
        }) : this._worker.on(e, function() {
          h.delay(t, arguments, r);
        }), this;
      }, resume: function() {
        return h.delay(this._worker.resume, [], this._worker), this;
      }, pause: function() {
        return this._worker.pause(), this;
      }, toNodejsStream: function(e) {
        if (h.checkSupport("nodestream"), this._outputType !== "nodebuffer")
          throw new Error(this._outputType + " is not supported by this method");
        return new o(this, { objectMode: this._outputType !== "nodebuffer" }, e);
      } }, t.exports = f;
    }, { "../base64": 1, "../external": 6, "../nodejs/NodejsStreamOutputAdapter": 13, "../support": 30, "../utils": 32, "./ConvertWorker": 24, "./GenericWorker": 28 }], 30: [function(e, t, r) {
      if (r.base64 = true, r.array = true, r.string = true, r.arraybuffer = typeof ArrayBuffer != "undefined" && typeof Uint8Array != "undefined", r.nodebuffer = typeof Buffer != "undefined", r.uint8array = typeof Uint8Array != "undefined", typeof ArrayBuffer == "undefined")
        r.blob = false;
      else {
        var n = new ArrayBuffer(0);
        try {
          r.blob = new Blob([n], { type: "application/zip" }).size === 0;
        } catch (e) {
          try {
            var i = new (self.BlobBuilder || self.WebKitBlobBuilder || self.MozBlobBuilder || self.MSBlobBuilder);
            i.append(n), r.blob = i.getBlob("application/zip").size === 0;
          } catch (e) {
            r.blob = false;
          }
        }
      }
      try {
        r.nodestream = !!e("readable-stream").Readable;
      } catch (e) {
        r.nodestream = false;
      }
    }, { "readable-stream": 16 }], 31: [function(e, t, s) {
      for (var o = e("./utils"), h = e("./support"), r = e("./nodejsUtils"), n = e("./stream/GenericWorker"), u = new Array(256), i = 0;i < 256; i++)
        u[i] = 252 <= i ? 6 : 248 <= i ? 5 : 240 <= i ? 4 : 224 <= i ? 3 : 192 <= i ? 2 : 1;
      u[254] = u[254] = 1;
      function a() {
        n.call(this, "utf-8 decode"), this.leftOver = null;
      }
      function l() {
        n.call(this, "utf-8 encode");
      }
      s.utf8encode = function(e) {
        return h.nodebuffer ? r.newBufferFrom(e, "utf-8") : function(e) {
          var t, r, n, i, s, a = e.length, o = 0;
          for (i = 0;i < a; i++)
            (64512 & (r = e.charCodeAt(i))) == 55296 && i + 1 < a && (64512 & (n = e.charCodeAt(i + 1))) == 56320 && (r = 65536 + (r - 55296 << 10) + (n - 56320), i++), o += r < 128 ? 1 : r < 2048 ? 2 : r < 65536 ? 3 : 4;
          for (t = h.uint8array ? new Uint8Array(o) : new Array(o), i = s = 0;s < o; i++)
            (64512 & (r = e.charCodeAt(i))) == 55296 && i + 1 < a && (64512 & (n = e.charCodeAt(i + 1))) == 56320 && (r = 65536 + (r - 55296 << 10) + (n - 56320), i++), r < 128 ? t[s++] = r : (r < 2048 ? t[s++] = 192 | r >>> 6 : (r < 65536 ? t[s++] = 224 | r >>> 12 : (t[s++] = 240 | r >>> 18, t[s++] = 128 | r >>> 12 & 63), t[s++] = 128 | r >>> 6 & 63), t[s++] = 128 | 63 & r);
          return t;
        }(e);
      }, s.utf8decode = function(e) {
        return h.nodebuffer ? o.transformTo("nodebuffer", e).toString("utf-8") : function(e) {
          var t, r, n, i, s = e.length, a = new Array(2 * s);
          for (t = r = 0;t < s; )
            if ((n = e[t++]) < 128)
              a[r++] = n;
            else if (4 < (i = u[n]))
              a[r++] = 65533, t += i - 1;
            else {
              for (n &= i === 2 ? 31 : i === 3 ? 15 : 7;1 < i && t < s; )
                n = n << 6 | 63 & e[t++], i--;
              1 < i ? a[r++] = 65533 : n < 65536 ? a[r++] = n : (n -= 65536, a[r++] = 55296 | n >> 10 & 1023, a[r++] = 56320 | 1023 & n);
            }
          return a.length !== r && (a.subarray ? a = a.subarray(0, r) : a.length = r), o.applyFromCharCode(a);
        }(e = o.transformTo(h.uint8array ? "uint8array" : "array", e));
      }, o.inherits(a, n), a.prototype.processChunk = function(e) {
        var t = o.transformTo(h.uint8array ? "uint8array" : "array", e.data);
        if (this.leftOver && this.leftOver.length) {
          if (h.uint8array) {
            var r = t;
            (t = new Uint8Array(r.length + this.leftOver.length)).set(this.leftOver, 0), t.set(r, this.leftOver.length);
          } else
            t = this.leftOver.concat(t);
          this.leftOver = null;
        }
        var n = function(e, t) {
          var r;
          for ((t = t || e.length) > e.length && (t = e.length), r = t - 1;0 <= r && (192 & e[r]) == 128; )
            r--;
          return r < 0 ? t : r === 0 ? t : r + u[e[r]] > t ? r : t;
        }(t), i = t;
        n !== t.length && (h.uint8array ? (i = t.subarray(0, n), this.leftOver = t.subarray(n, t.length)) : (i = t.slice(0, n), this.leftOver = t.slice(n, t.length))), this.push({ data: s.utf8decode(i), meta: e.meta });
      }, a.prototype.flush = function() {
        this.leftOver && this.leftOver.length && (this.push({ data: s.utf8decode(this.leftOver), meta: {} }), this.leftOver = null);
      }, s.Utf8DecodeWorker = a, o.inherits(l, n), l.prototype.processChunk = function(e) {
        this.push({ data: s.utf8encode(e.data), meta: e.meta });
      }, s.Utf8EncodeWorker = l;
    }, { "./nodejsUtils": 14, "./stream/GenericWorker": 28, "./support": 30, "./utils": 32 }], 32: [function(e, t, a) {
      var o = e("./support"), h = e("./base64"), r = e("./nodejsUtils"), u = e("./external");
      function n(e) {
        return e;
      }
      function l(e, t) {
        for (var r = 0;r < e.length; ++r)
          t[r] = 255 & e.charCodeAt(r);
        return t;
      }
      e("setimmediate"), a.newBlob = function(t, r) {
        a.checkSupport("blob");
        try {
          return new Blob([t], { type: r });
        } catch (e) {
          try {
            var n = new (self.BlobBuilder || self.WebKitBlobBuilder || self.MozBlobBuilder || self.MSBlobBuilder);
            return n.append(t), n.getBlob(r);
          } catch (e) {
            throw new Error("Bug : can't construct the Blob.");
          }
        }
      };
      var i = { stringifyByChunk: function(e, t, r) {
        var n = [], i = 0, s = e.length;
        if (s <= r)
          return String.fromCharCode.apply(null, e);
        for (;i < s; )
          t === "array" || t === "nodebuffer" ? n.push(String.fromCharCode.apply(null, e.slice(i, Math.min(i + r, s)))) : n.push(String.fromCharCode.apply(null, e.subarray(i, Math.min(i + r, s)))), i += r;
        return n.join("");
      }, stringifyByChar: function(e) {
        for (var t = "", r = 0;r < e.length; r++)
          t += String.fromCharCode(e[r]);
        return t;
      }, applyCanBeUsed: { uint8array: function() {
        try {
          return o.uint8array && String.fromCharCode.apply(null, new Uint8Array(1)).length === 1;
        } catch (e) {
          return false;
        }
      }(), nodebuffer: function() {
        try {
          return o.nodebuffer && String.fromCharCode.apply(null, r.allocBuffer(1)).length === 1;
        } catch (e) {
          return false;
        }
      }() } };
      function s(e) {
        var t = 65536, r = a.getTypeOf(e), n = true;
        if (r === "uint8array" ? n = i.applyCanBeUsed.uint8array : r === "nodebuffer" && (n = i.applyCanBeUsed.nodebuffer), n)
          for (;1 < t; )
            try {
              return i.stringifyByChunk(e, r, t);
            } catch (e) {
              t = Math.floor(t / 2);
            }
        return i.stringifyByChar(e);
      }
      function f(e, t) {
        for (var r = 0;r < e.length; r++)
          t[r] = e[r];
        return t;
      }
      a.applyFromCharCode = s;
      var c = {};
      c.string = { string: n, array: function(e) {
        return l(e, new Array(e.length));
      }, arraybuffer: function(e) {
        return c.string.uint8array(e).buffer;
      }, uint8array: function(e) {
        return l(e, new Uint8Array(e.length));
      }, nodebuffer: function(e) {
        return l(e, r.allocBuffer(e.length));
      } }, c.array = { string: s, array: n, arraybuffer: function(e) {
        return new Uint8Array(e).buffer;
      }, uint8array: function(e) {
        return new Uint8Array(e);
      }, nodebuffer: function(e) {
        return r.newBufferFrom(e);
      } }, c.arraybuffer = { string: function(e) {
        return s(new Uint8Array(e));
      }, array: function(e) {
        return f(new Uint8Array(e), new Array(e.byteLength));
      }, arraybuffer: n, uint8array: function(e) {
        return new Uint8Array(e);
      }, nodebuffer: function(e) {
        return r.newBufferFrom(new Uint8Array(e));
      } }, c.uint8array = { string: s, array: function(e) {
        return f(e, new Array(e.length));
      }, arraybuffer: function(e) {
        return e.buffer;
      }, uint8array: n, nodebuffer: function(e) {
        return r.newBufferFrom(e);
      } }, c.nodebuffer = { string: s, array: function(e) {
        return f(e, new Array(e.length));
      }, arraybuffer: function(e) {
        return c.nodebuffer.uint8array(e).buffer;
      }, uint8array: function(e) {
        return f(e, new Uint8Array(e.length));
      }, nodebuffer: n }, a.transformTo = function(e, t) {
        if (t = t || "", !e)
          return t;
        a.checkSupport(e);
        var r = a.getTypeOf(t);
        return c[r][e](t);
      }, a.resolve = function(e) {
        for (var t = e.split("/"), r = [], n = 0;n < t.length; n++) {
          var i = t[n];
          i === "." || i === "" && n !== 0 && n !== t.length - 1 || (i === ".." ? r.pop() : r.push(i));
        }
        return r.join("/");
      }, a.getTypeOf = function(e) {
        if (typeof e == "string")
          return "string";
        var t = Object.prototype.toString.call(e);
        return t === "[object Array]" ? "array" : o.nodebuffer && r.isBuffer(e) ? "nodebuffer" : o.uint8array && t === "[object Uint8Array]" ? "uint8array" : o.arraybuffer && t === "[object ArrayBuffer]" ? "arraybuffer" : undefined;
      }, a.checkSupport = function(e) {
        if (!o[e.toLowerCase()])
          throw new Error(e + " is not supported by this platform");
      }, a.MAX_VALUE_16BITS = 65535, a.MAX_VALUE_32BITS = -1, a.pretty = function(e) {
        var t, r, n = "";
        for (r = 0;r < (e || "").length; r++)
          n += "\\x" + ((t = e.charCodeAt(r)) < 16 ? "0" : "") + t.toString(16).toUpperCase();
        return n;
      }, a.delay = function(e, t, r) {
        setImmediate(function() {
          e.apply(r || null, t || []);
        });
      }, a.inherits = function(e, t) {
        function r() {}
        r.prototype = t.prototype, e.prototype = new r;
      }, a.extend = function() {
        var e, t, r = {};
        for (e = 0;e < arguments.length; e++)
          for (t in arguments[e])
            Object.prototype.hasOwnProperty.call(arguments[e], t) && r[t] === undefined && (r[t] = arguments[e][t]);
        return r;
      }, a.prepareContent = function(r, e, n, i, s) {
        return u.Promise.resolve(e).then(function(n) {
          return o.blob && (n instanceof Blob || ["[object File]", "[object Blob]"].indexOf(Object.prototype.toString.call(n)) !== -1) ? Blob.prototype.arrayBuffer !== undefined ? n.arrayBuffer() : typeof FileReader != "undefined" ? new u.Promise(function(t, r) {
            var e = new FileReader;
            e.onload = function(e) {
              t(e.target.result);
            }, e.onerror = function(e) {
              r(e.target.error);
            }, e.readAsArrayBuffer(n);
          }) : u.Promise.reject(new Error(r + " is a Blob, but we have no way of reading it.")) : n;
        }).then(function(e) {
          var t = a.getTypeOf(e);
          return t ? (t === "arraybuffer" ? e = a.transformTo("uint8array", e) : t === "string" && (s ? e = h.decode(e) : n && i !== true && (e = function(e) {
            return l(e, o.uint8array ? new Uint8Array(e.length) : new Array(e.length));
          }(e))), e) : u.Promise.reject(new Error("Can't read the data of '" + r + "'. Is it in a supported JavaScript type (String, Blob, ArrayBuffer, etc) ?"));
        });
      };
    }, { "./base64": 1, "./external": 6, "./nodejsUtils": 14, "./support": 30, setimmediate: 54 }], 33: [function(e, t, r) {
      var n = e("./reader/readerFor"), i = e("./utils"), s = e("./signature"), a = e("./zipEntry"), o = e("./support");
      function h(e) {
        this.files = [], this.loadOptions = e;
      }
      h.prototype = { checkSignature: function(e) {
        if (!this.reader.readAndCheckSignature(e)) {
          this.reader.index -= 4;
          var t = this.reader.readString(4);
          throw new Error("Corrupted zip or bug: unexpected signature (" + i.pretty(t) + ", expected " + i.pretty(e) + ")");
        }
      }, isSignature: function(e, t) {
        var r = this.reader.index;
        this.reader.setIndex(e);
        var n = this.reader.readString(4) === t;
        return this.reader.setIndex(r), n;
      }, readBlockEndOfCentral: function() {
        this.diskNumber = this.reader.readInt(2), this.diskWithCentralDirStart = this.reader.readInt(2), this.centralDirRecordsOnThisDisk = this.reader.readInt(2), this.centralDirRecords = this.reader.readInt(2), this.centralDirSize = this.reader.readInt(4), this.centralDirOffset = this.reader.readInt(4), this.zipCommentLength = this.reader.readInt(2);
        var e = this.reader.readData(this.zipCommentLength), t = o.uint8array ? "uint8array" : "array", r = i.transformTo(t, e);
        this.zipComment = this.loadOptions.decodeFileName(r);
      }, readBlockZip64EndOfCentral: function() {
        this.zip64EndOfCentralSize = this.reader.readInt(8), this.reader.skip(4), this.diskNumber = this.reader.readInt(4), this.diskWithCentralDirStart = this.reader.readInt(4), this.centralDirRecordsOnThisDisk = this.reader.readInt(8), this.centralDirRecords = this.reader.readInt(8), this.centralDirSize = this.reader.readInt(8), this.centralDirOffset = this.reader.readInt(8), this.zip64ExtensibleData = {};
        for (var e, t, r, n = this.zip64EndOfCentralSize - 44;0 < n; )
          e = this.reader.readInt(2), t = this.reader.readInt(4), r = this.reader.readData(t), this.zip64ExtensibleData[e] = { id: e, length: t, value: r };
      }, readBlockZip64EndOfCentralLocator: function() {
        if (this.diskWithZip64CentralDirStart = this.reader.readInt(4), this.relativeOffsetEndOfZip64CentralDir = this.reader.readInt(8), this.disksCount = this.reader.readInt(4), 1 < this.disksCount)
          throw new Error("Multi-volumes zip are not supported");
      }, readLocalFiles: function() {
        var e, t;
        for (e = 0;e < this.files.length; e++)
          t = this.files[e], this.reader.setIndex(t.localHeaderOffset), this.checkSignature(s.LOCAL_FILE_HEADER), t.readLocalPart(this.reader), t.handleUTF8(), t.processAttributes();
      }, readCentralDir: function() {
        var e;
        for (this.reader.setIndex(this.centralDirOffset);this.reader.readAndCheckSignature(s.CENTRAL_FILE_HEADER); )
          (e = new a({ zip64: this.zip64 }, this.loadOptions)).readCentralPart(this.reader), this.files.push(e);
        if (this.centralDirRecords !== this.files.length && this.centralDirRecords !== 0 && this.files.length === 0)
          throw new Error("Corrupted zip or bug: expected " + this.centralDirRecords + " records in central dir, got " + this.files.length);
      }, readEndOfCentral: function() {
        var e = this.reader.lastIndexOfSignature(s.CENTRAL_DIRECTORY_END);
        if (e < 0)
          throw !this.isSignature(0, s.LOCAL_FILE_HEADER) ? new Error("Can't find end of central directory : is this a zip file ? If it is, see https://stuk.github.io/jszip/documentation/howto/read_zip.html") : new Error("Corrupted zip: can't find end of central directory");
        this.reader.setIndex(e);
        var t = e;
        if (this.checkSignature(s.CENTRAL_DIRECTORY_END), this.readBlockEndOfCentral(), this.diskNumber === i.MAX_VALUE_16BITS || this.diskWithCentralDirStart === i.MAX_VALUE_16BITS || this.centralDirRecordsOnThisDisk === i.MAX_VALUE_16BITS || this.centralDirRecords === i.MAX_VALUE_16BITS || this.centralDirSize === i.MAX_VALUE_32BITS || this.centralDirOffset === i.MAX_VALUE_32BITS) {
          if (this.zip64 = true, (e = this.reader.lastIndexOfSignature(s.ZIP64_CENTRAL_DIRECTORY_LOCATOR)) < 0)
            throw new Error("Corrupted zip: can't find the ZIP64 end of central directory locator");
          if (this.reader.setIndex(e), this.checkSignature(s.ZIP64_CENTRAL_DIRECTORY_LOCATOR), this.readBlockZip64EndOfCentralLocator(), !this.isSignature(this.relativeOffsetEndOfZip64CentralDir, s.ZIP64_CENTRAL_DIRECTORY_END) && (this.relativeOffsetEndOfZip64CentralDir = this.reader.lastIndexOfSignature(s.ZIP64_CENTRAL_DIRECTORY_END), this.relativeOffsetEndOfZip64CentralDir < 0))
            throw new Error("Corrupted zip: can't find the ZIP64 end of central directory");
          this.reader.setIndex(this.relativeOffsetEndOfZip64CentralDir), this.checkSignature(s.ZIP64_CENTRAL_DIRECTORY_END), this.readBlockZip64EndOfCentral();
        }
        var r = this.centralDirOffset + this.centralDirSize;
        this.zip64 && (r += 20, r += 12 + this.zip64EndOfCentralSize);
        var n = t - r;
        if (0 < n)
          this.isSignature(t, s.CENTRAL_FILE_HEADER) || (this.reader.zero = n);
        else if (n < 0)
          throw new Error("Corrupted zip: missing " + Math.abs(n) + " bytes.");
      }, prepareReader: function(e) {
        this.reader = n(e);
      }, load: function(e) {
        this.prepareReader(e), this.readEndOfCentral(), this.readCentralDir(), this.readLocalFiles();
      } }, t.exports = h;
    }, { "./reader/readerFor": 22, "./signature": 23, "./support": 30, "./utils": 32, "./zipEntry": 34 }], 34: [function(e, t, r) {
      var n = e("./reader/readerFor"), s = e("./utils"), i = e("./compressedObject"), a = e("./crc32"), o = e("./utf8"), h = e("./compressions"), u = e("./support");
      function l(e, t) {
        this.options = e, this.loadOptions = t;
      }
      l.prototype = { isEncrypted: function() {
        return (1 & this.bitFlag) == 1;
      }, useUTF8: function() {
        return (2048 & this.bitFlag) == 2048;
      }, readLocalPart: function(e) {
        var t, r;
        if (e.skip(22), this.fileNameLength = e.readInt(2), r = e.readInt(2), this.fileName = e.readData(this.fileNameLength), e.skip(r), this.compressedSize === -1 || this.uncompressedSize === -1)
          throw new Error("Bug or corrupted zip : didn't get enough information from the central directory (compressedSize === -1 || uncompressedSize === -1)");
        if ((t = function(e) {
          for (var t in h)
            if (Object.prototype.hasOwnProperty.call(h, t) && h[t].magic === e)
              return h[t];
          return null;
        }(this.compressionMethod)) === null)
          throw new Error("Corrupted zip : compression " + s.pretty(this.compressionMethod) + " unknown (inner file : " + s.transformTo("string", this.fileName) + ")");
        this.decompressed = new i(this.compressedSize, this.uncompressedSize, this.crc32, t, e.readData(this.compressedSize));
      }, readCentralPart: function(e) {
        this.versionMadeBy = e.readInt(2), e.skip(2), this.bitFlag = e.readInt(2), this.compressionMethod = e.readString(2), this.date = e.readDate(), this.crc32 = e.readInt(4), this.compressedSize = e.readInt(4), this.uncompressedSize = e.readInt(4);
        var t = e.readInt(2);
        if (this.extraFieldsLength = e.readInt(2), this.fileCommentLength = e.readInt(2), this.diskNumberStart = e.readInt(2), this.internalFileAttributes = e.readInt(2), this.externalFileAttributes = e.readInt(4), this.localHeaderOffset = e.readInt(4), this.isEncrypted())
          throw new Error("Encrypted zip are not supported");
        e.skip(t), this.readExtraFields(e), this.parseZIP64ExtraField(e), this.fileComment = e.readData(this.fileCommentLength);
      }, processAttributes: function() {
        this.unixPermissions = null, this.dosPermissions = null;
        var e = this.versionMadeBy >> 8;
        this.dir = !!(16 & this.externalFileAttributes), e == 0 && (this.dosPermissions = 63 & this.externalFileAttributes), e == 3 && (this.unixPermissions = this.externalFileAttributes >> 16 & 65535), this.dir || this.fileNameStr.slice(-1) !== "/" || (this.dir = true);
      }, parseZIP64ExtraField: function() {
        if (this.extraFields[1]) {
          var e = n(this.extraFields[1].value);
          this.uncompressedSize === s.MAX_VALUE_32BITS && (this.uncompressedSize = e.readInt(8)), this.compressedSize === s.MAX_VALUE_32BITS && (this.compressedSize = e.readInt(8)), this.localHeaderOffset === s.MAX_VALUE_32BITS && (this.localHeaderOffset = e.readInt(8)), this.diskNumberStart === s.MAX_VALUE_32BITS && (this.diskNumberStart = e.readInt(4));
        }
      }, readExtraFields: function(e) {
        var t, r, n, i = e.index + this.extraFieldsLength;
        for (this.extraFields || (this.extraFields = {});e.index + 4 < i; )
          t = e.readInt(2), r = e.readInt(2), n = e.readData(r), this.extraFields[t] = { id: t, length: r, value: n };
        e.setIndex(i);
      }, handleUTF8: function() {
        var e = u.uint8array ? "uint8array" : "array";
        if (this.useUTF8())
          this.fileNameStr = o.utf8decode(this.fileName), this.fileCommentStr = o.utf8decode(this.fileComment);
        else {
          var t = this.findExtraFieldUnicodePath();
          if (t !== null)
            this.fileNameStr = t;
          else {
            var r = s.transformTo(e, this.fileName);
            this.fileNameStr = this.loadOptions.decodeFileName(r);
          }
          var n = this.findExtraFieldUnicodeComment();
          if (n !== null)
            this.fileCommentStr = n;
          else {
            var i = s.transformTo(e, this.fileComment);
            this.fileCommentStr = this.loadOptions.decodeFileName(i);
          }
        }
      }, findExtraFieldUnicodePath: function() {
        var e = this.extraFields[28789];
        if (e) {
          var t = n(e.value);
          return t.readInt(1) !== 1 ? null : a(this.fileName) !== t.readInt(4) ? null : o.utf8decode(t.readData(e.length - 5));
        }
        return null;
      }, findExtraFieldUnicodeComment: function() {
        var e = this.extraFields[25461];
        if (e) {
          var t = n(e.value);
          return t.readInt(1) !== 1 ? null : a(this.fileComment) !== t.readInt(4) ? null : o.utf8decode(t.readData(e.length - 5));
        }
        return null;
      } }, t.exports = l;
    }, { "./compressedObject": 2, "./compressions": 3, "./crc32": 4, "./reader/readerFor": 22, "./support": 30, "./utf8": 31, "./utils": 32 }], 35: [function(e, t, r) {
      function n(e, t, r) {
        this.name = e, this.dir = r.dir, this.date = r.date, this.comment = r.comment, this.unixPermissions = r.unixPermissions, this.dosPermissions = r.dosPermissions, this._data = t, this._dataBinary = r.binary, this.options = { compression: r.compression, compressionOptions: r.compressionOptions };
      }
      var s = e("./stream/StreamHelper"), i = e("./stream/DataWorker"), a = e("./utf8"), o = e("./compressedObject"), h = e("./stream/GenericWorker");
      n.prototype = { internalStream: function(e) {
        var t = null, r = "string";
        try {
          if (!e)
            throw new Error("No output type specified.");
          var n = (r = e.toLowerCase()) === "string" || r === "text";
          r !== "binarystring" && r !== "text" || (r = "string"), t = this._decompressWorker();
          var i = !this._dataBinary;
          i && !n && (t = t.pipe(new a.Utf8EncodeWorker)), !i && n && (t = t.pipe(new a.Utf8DecodeWorker));
        } catch (e) {
          (t = new h("error")).error(e);
        }
        return new s(t, r, "");
      }, async: function(e, t) {
        return this.internalStream(e).accumulate(t);
      }, nodeStream: function(e, t) {
        return this.internalStream(e || "nodebuffer").toNodejsStream(t);
      }, _compressWorker: function(e, t) {
        if (this._data instanceof o && this._data.compression.magic === e.magic)
          return this._data.getCompressedWorker();
        var r = this._decompressWorker();
        return this._dataBinary || (r = r.pipe(new a.Utf8EncodeWorker)), o.createWorkerFrom(r, e, t);
      }, _decompressWorker: function() {
        return this._data instanceof o ? this._data.getContentWorker() : this._data instanceof h ? this._data : new i(this._data);
      } };
      for (var u = ["asText", "asBinary", "asNodeBuffer", "asUint8Array", "asArrayBuffer"], l = function() {
        throw new Error("This method has been removed in JSZip 3.0, please check the upgrade guide.");
      }, f = 0;f < u.length; f++)
        n.prototype[u[f]] = l;
      t.exports = n;
    }, { "./compressedObject": 2, "./stream/DataWorker": 27, "./stream/GenericWorker": 28, "./stream/StreamHelper": 29, "./utf8": 31 }], 36: [function(e, l, t) {
      (function(t) {
        var r, n, e = t.MutationObserver || t.WebKitMutationObserver;
        if (e) {
          var i = 0, s = new e(u), a = t.document.createTextNode("");
          s.observe(a, { characterData: true }), r = function() {
            a.data = i = ++i % 2;
          };
        } else if (t.setImmediate || t.MessageChannel === undefined)
          r = "document" in t && "onreadystatechange" in t.document.createElement("script") ? function() {
            var e = t.document.createElement("script");
            e.onreadystatechange = function() {
              u(), e.onreadystatechange = null, e.parentNode.removeChild(e), e = null;
            }, t.document.documentElement.appendChild(e);
          } : function() {
            setTimeout(u, 0);
          };
        else {
          var o = new t.MessageChannel;
          o.port1.onmessage = u, r = function() {
            o.port2.postMessage(0);
          };
        }
        var h = [];
        function u() {
          var e, t;
          n = true;
          for (var r = h.length;r; ) {
            for (t = h, h = [], e = -1;++e < r; )
              t[e]();
            r = h.length;
          }
          n = false;
        }
        l.exports = function(e) {
          h.push(e) !== 1 || n || r();
        };
      }).call(this, typeof global != "undefined" ? global : typeof self != "undefined" ? self : typeof window != "undefined" ? window : {});
    }, {}], 37: [function(e, t, r) {
      var i = e("immediate");
      function u() {}
      var l = {}, s = ["REJECTED"], a = ["FULFILLED"], n = ["PENDING"];
      function o(e) {
        if (typeof e != "function")
          throw new TypeError("resolver must be a function");
        this.state = n, this.queue = [], this.outcome = undefined, e !== u && d(this, e);
      }
      function h(e, t, r) {
        this.promise = e, typeof t == "function" && (this.onFulfilled = t, this.callFulfilled = this.otherCallFulfilled), typeof r == "function" && (this.onRejected = r, this.callRejected = this.otherCallRejected);
      }
      function f(t, r, n) {
        i(function() {
          var e;
          try {
            e = r(n);
          } catch (e) {
            return l.reject(t, e);
          }
          e === t ? l.reject(t, new TypeError("Cannot resolve promise with itself")) : l.resolve(t, e);
        });
      }
      function c(e) {
        var t = e && e.then;
        if (e && (typeof e == "object" || typeof e == "function") && typeof t == "function")
          return function() {
            t.apply(e, arguments);
          };
      }
      function d(t, e) {
        var r = false;
        function n(e) {
          r || (r = true, l.reject(t, e));
        }
        function i(e) {
          r || (r = true, l.resolve(t, e));
        }
        var s = p(function() {
          e(i, n);
        });
        s.status === "error" && n(s.value);
      }
      function p(e, t) {
        var r = {};
        try {
          r.value = e(t), r.status = "success";
        } catch (e) {
          r.status = "error", r.value = e;
        }
        return r;
      }
      (t.exports = o).prototype.finally = function(t) {
        if (typeof t != "function")
          return this;
        var r = this.constructor;
        return this.then(function(e) {
          return r.resolve(t()).then(function() {
            return e;
          });
        }, function(e) {
          return r.resolve(t()).then(function() {
            throw e;
          });
        });
      }, o.prototype.catch = function(e) {
        return this.then(null, e);
      }, o.prototype.then = function(e, t) {
        if (typeof e != "function" && this.state === a || typeof t != "function" && this.state === s)
          return this;
        var r = new this.constructor(u);
        this.state !== n ? f(r, this.state === a ? e : t, this.outcome) : this.queue.push(new h(r, e, t));
        return r;
      }, h.prototype.callFulfilled = function(e) {
        l.resolve(this.promise, e);
      }, h.prototype.otherCallFulfilled = function(e) {
        f(this.promise, this.onFulfilled, e);
      }, h.prototype.callRejected = function(e) {
        l.reject(this.promise, e);
      }, h.prototype.otherCallRejected = function(e) {
        f(this.promise, this.onRejected, e);
      }, l.resolve = function(e, t) {
        var r = p(c, t);
        if (r.status === "error")
          return l.reject(e, r.value);
        var n = r.value;
        if (n)
          d(e, n);
        else {
          e.state = a, e.outcome = t;
          for (var i = -1, s = e.queue.length;++i < s; )
            e.queue[i].callFulfilled(t);
        }
        return e;
      }, l.reject = function(e, t) {
        e.state = s, e.outcome = t;
        for (var r = -1, n = e.queue.length;++r < n; )
          e.queue[r].callRejected(t);
        return e;
      }, o.resolve = function(e) {
        if (e instanceof this)
          return e;
        return l.resolve(new this(u), e);
      }, o.reject = function(e) {
        var t = new this(u);
        return l.reject(t, e);
      }, o.all = function(e) {
        var r = this;
        if (Object.prototype.toString.call(e) !== "[object Array]")
          return this.reject(new TypeError("must be an array"));
        var n = e.length, i = false;
        if (!n)
          return this.resolve([]);
        var s = new Array(n), a = 0, t = -1, o = new this(u);
        for (;++t < n; )
          h(e[t], t);
        return o;
        function h(e, t) {
          r.resolve(e).then(function(e) {
            s[t] = e, ++a !== n || i || (i = true, l.resolve(o, s));
          }, function(e) {
            i || (i = true, l.reject(o, e));
          });
        }
      }, o.race = function(e) {
        var t = this;
        if (Object.prototype.toString.call(e) !== "[object Array]")
          return this.reject(new TypeError("must be an array"));
        var r = e.length, n = false;
        if (!r)
          return this.resolve([]);
        var i = -1, s = new this(u);
        for (;++i < r; )
          a = e[i], t.resolve(a).then(function(e) {
            n || (n = true, l.resolve(s, e));
          }, function(e) {
            n || (n = true, l.reject(s, e));
          });
        var a;
        return s;
      };
    }, { immediate: 36 }], 38: [function(e, t, r) {
      var n = {};
      (0, e("./lib/utils/common").assign)(n, e("./lib/deflate"), e("./lib/inflate"), e("./lib/zlib/constants")), t.exports = n;
    }, { "./lib/deflate": 39, "./lib/inflate": 40, "./lib/utils/common": 41, "./lib/zlib/constants": 44 }], 39: [function(e, t, r) {
      var a = e("./zlib/deflate"), o = e("./utils/common"), h = e("./utils/strings"), i = e("./zlib/messages"), s = e("./zlib/zstream"), u = Object.prototype.toString, l = 0, f = -1, c = 0, d = 8;
      function p(e) {
        if (!(this instanceof p))
          return new p(e);
        this.options = o.assign({ level: f, method: d, chunkSize: 16384, windowBits: 15, memLevel: 8, strategy: c, to: "" }, e || {});
        var t = this.options;
        t.raw && 0 < t.windowBits ? t.windowBits = -t.windowBits : t.gzip && 0 < t.windowBits && t.windowBits < 16 && (t.windowBits += 16), this.err = 0, this.msg = "", this.ended = false, this.chunks = [], this.strm = new s, this.strm.avail_out = 0;
        var r = a.deflateInit2(this.strm, t.level, t.method, t.windowBits, t.memLevel, t.strategy);
        if (r !== l)
          throw new Error(i[r]);
        if (t.header && a.deflateSetHeader(this.strm, t.header), t.dictionary) {
          var n;
          if (n = typeof t.dictionary == "string" ? h.string2buf(t.dictionary) : u.call(t.dictionary) === "[object ArrayBuffer]" ? new Uint8Array(t.dictionary) : t.dictionary, (r = a.deflateSetDictionary(this.strm, n)) !== l)
            throw new Error(i[r]);
          this._dict_set = true;
        }
      }
      function n(e, t) {
        var r = new p(t);
        if (r.push(e, true), r.err)
          throw r.msg || i[r.err];
        return r.result;
      }
      p.prototype.push = function(e, t) {
        var r, n, i = this.strm, s = this.options.chunkSize;
        if (this.ended)
          return false;
        n = t === ~~t ? t : t === true ? 4 : 0, typeof e == "string" ? i.input = h.string2buf(e) : u.call(e) === "[object ArrayBuffer]" ? i.input = new Uint8Array(e) : i.input = e, i.next_in = 0, i.avail_in = i.input.length;
        do {
          if (i.avail_out === 0 && (i.output = new o.Buf8(s), i.next_out = 0, i.avail_out = s), (r = a.deflate(i, n)) !== 1 && r !== l)
            return this.onEnd(r), !(this.ended = true);
          i.avail_out !== 0 && (i.avail_in !== 0 || n !== 4 && n !== 2) || (this.options.to === "string" ? this.onData(h.buf2binstring(o.shrinkBuf(i.output, i.next_out))) : this.onData(o.shrinkBuf(i.output, i.next_out)));
        } while ((0 < i.avail_in || i.avail_out === 0) && r !== 1);
        return n === 4 ? (r = a.deflateEnd(this.strm), this.onEnd(r), this.ended = true, r === l) : n !== 2 || (this.onEnd(l), !(i.avail_out = 0));
      }, p.prototype.onData = function(e) {
        this.chunks.push(e);
      }, p.prototype.onEnd = function(e) {
        e === l && (this.options.to === "string" ? this.result = this.chunks.join("") : this.result = o.flattenChunks(this.chunks)), this.chunks = [], this.err = e, this.msg = this.strm.msg;
      }, r.Deflate = p, r.deflate = n, r.deflateRaw = function(e, t) {
        return (t = t || {}).raw = true, n(e, t);
      }, r.gzip = function(e, t) {
        return (t = t || {}).gzip = true, n(e, t);
      };
    }, { "./utils/common": 41, "./utils/strings": 42, "./zlib/deflate": 46, "./zlib/messages": 51, "./zlib/zstream": 53 }], 40: [function(e, t, r) {
      var c = e("./zlib/inflate"), d = e("./utils/common"), p = e("./utils/strings"), m = e("./zlib/constants"), n = e("./zlib/messages"), i = e("./zlib/zstream"), s = e("./zlib/gzheader"), _ = Object.prototype.toString;
      function a(e) {
        if (!(this instanceof a))
          return new a(e);
        this.options = d.assign({ chunkSize: 16384, windowBits: 0, to: "" }, e || {});
        var t = this.options;
        t.raw && 0 <= t.windowBits && t.windowBits < 16 && (t.windowBits = -t.windowBits, t.windowBits === 0 && (t.windowBits = -15)), !(0 <= t.windowBits && t.windowBits < 16) || e && e.windowBits || (t.windowBits += 32), 15 < t.windowBits && t.windowBits < 48 && (15 & t.windowBits) == 0 && (t.windowBits |= 15), this.err = 0, this.msg = "", this.ended = false, this.chunks = [], this.strm = new i, this.strm.avail_out = 0;
        var r = c.inflateInit2(this.strm, t.windowBits);
        if (r !== m.Z_OK)
          throw new Error(n[r]);
        this.header = new s, c.inflateGetHeader(this.strm, this.header);
      }
      function o(e, t) {
        var r = new a(t);
        if (r.push(e, true), r.err)
          throw r.msg || n[r.err];
        return r.result;
      }
      a.prototype.push = function(e, t) {
        var r, n, i, s, a, o, h = this.strm, u = this.options.chunkSize, l = this.options.dictionary, f = false;
        if (this.ended)
          return false;
        n = t === ~~t ? t : t === true ? m.Z_FINISH : m.Z_NO_FLUSH, typeof e == "string" ? h.input = p.binstring2buf(e) : _.call(e) === "[object ArrayBuffer]" ? h.input = new Uint8Array(e) : h.input = e, h.next_in = 0, h.avail_in = h.input.length;
        do {
          if (h.avail_out === 0 && (h.output = new d.Buf8(u), h.next_out = 0, h.avail_out = u), (r = c.inflate(h, m.Z_NO_FLUSH)) === m.Z_NEED_DICT && l && (o = typeof l == "string" ? p.string2buf(l) : _.call(l) === "[object ArrayBuffer]" ? new Uint8Array(l) : l, r = c.inflateSetDictionary(this.strm, o)), r === m.Z_BUF_ERROR && f === true && (r = m.Z_OK, f = false), r !== m.Z_STREAM_END && r !== m.Z_OK)
            return this.onEnd(r), !(this.ended = true);
          h.next_out && (h.avail_out !== 0 && r !== m.Z_STREAM_END && (h.avail_in !== 0 || n !== m.Z_FINISH && n !== m.Z_SYNC_FLUSH) || (this.options.to === "string" ? (i = p.utf8border(h.output, h.next_out), s = h.next_out - i, a = p.buf2string(h.output, i), h.next_out = s, h.avail_out = u - s, s && d.arraySet(h.output, h.output, i, s, 0), this.onData(a)) : this.onData(d.shrinkBuf(h.output, h.next_out)))), h.avail_in === 0 && h.avail_out === 0 && (f = true);
        } while ((0 < h.avail_in || h.avail_out === 0) && r !== m.Z_STREAM_END);
        return r === m.Z_STREAM_END && (n = m.Z_FINISH), n === m.Z_FINISH ? (r = c.inflateEnd(this.strm), this.onEnd(r), this.ended = true, r === m.Z_OK) : n !== m.Z_SYNC_FLUSH || (this.onEnd(m.Z_OK), !(h.avail_out = 0));
      }, a.prototype.onData = function(e) {
        this.chunks.push(e);
      }, a.prototype.onEnd = function(e) {
        e === m.Z_OK && (this.options.to === "string" ? this.result = this.chunks.join("") : this.result = d.flattenChunks(this.chunks)), this.chunks = [], this.err = e, this.msg = this.strm.msg;
      }, r.Inflate = a, r.inflate = o, r.inflateRaw = function(e, t) {
        return (t = t || {}).raw = true, o(e, t);
      }, r.ungzip = o;
    }, { "./utils/common": 41, "./utils/strings": 42, "./zlib/constants": 44, "./zlib/gzheader": 47, "./zlib/inflate": 49, "./zlib/messages": 51, "./zlib/zstream": 53 }], 41: [function(e, t, r) {
      var n = typeof Uint8Array != "undefined" && typeof Uint16Array != "undefined" && typeof Int32Array != "undefined";
      r.assign = function(e) {
        for (var t = Array.prototype.slice.call(arguments, 1);t.length; ) {
          var r = t.shift();
          if (r) {
            if (typeof r != "object")
              throw new TypeError(r + "must be non-object");
            for (var n in r)
              r.hasOwnProperty(n) && (e[n] = r[n]);
          }
        }
        return e;
      }, r.shrinkBuf = function(e, t) {
        return e.length === t ? e : e.subarray ? e.subarray(0, t) : (e.length = t, e);
      };
      var i = { arraySet: function(e, t, r, n, i) {
        if (t.subarray && e.subarray)
          e.set(t.subarray(r, r + n), i);
        else
          for (var s = 0;s < n; s++)
            e[i + s] = t[r + s];
      }, flattenChunks: function(e) {
        var t, r, n, i, s, a;
        for (t = n = 0, r = e.length;t < r; t++)
          n += e[t].length;
        for (a = new Uint8Array(n), t = i = 0, r = e.length;t < r; t++)
          s = e[t], a.set(s, i), i += s.length;
        return a;
      } }, s = { arraySet: function(e, t, r, n, i) {
        for (var s = 0;s < n; s++)
          e[i + s] = t[r + s];
      }, flattenChunks: function(e) {
        return [].concat.apply([], e);
      } };
      r.setTyped = function(e) {
        e ? (r.Buf8 = Uint8Array, r.Buf16 = Uint16Array, r.Buf32 = Int32Array, r.assign(r, i)) : (r.Buf8 = Array, r.Buf16 = Array, r.Buf32 = Array, r.assign(r, s));
      }, r.setTyped(n);
    }, {}], 42: [function(e, t, r) {
      var h = e("./common"), i = true, s = true;
      try {
        String.fromCharCode.apply(null, [0]);
      } catch (e) {
        i = false;
      }
      try {
        String.fromCharCode.apply(null, new Uint8Array(1));
      } catch (e) {
        s = false;
      }
      for (var u = new h.Buf8(256), n = 0;n < 256; n++)
        u[n] = 252 <= n ? 6 : 248 <= n ? 5 : 240 <= n ? 4 : 224 <= n ? 3 : 192 <= n ? 2 : 1;
      function l(e, t) {
        if (t < 65537 && (e.subarray && s || !e.subarray && i))
          return String.fromCharCode.apply(null, h.shrinkBuf(e, t));
        for (var r = "", n = 0;n < t; n++)
          r += String.fromCharCode(e[n]);
        return r;
      }
      u[254] = u[254] = 1, r.string2buf = function(e) {
        var t, r, n, i, s, a = e.length, o = 0;
        for (i = 0;i < a; i++)
          (64512 & (r = e.charCodeAt(i))) == 55296 && i + 1 < a && (64512 & (n = e.charCodeAt(i + 1))) == 56320 && (r = 65536 + (r - 55296 << 10) + (n - 56320), i++), o += r < 128 ? 1 : r < 2048 ? 2 : r < 65536 ? 3 : 4;
        for (t = new h.Buf8(o), i = s = 0;s < o; i++)
          (64512 & (r = e.charCodeAt(i))) == 55296 && i + 1 < a && (64512 & (n = e.charCodeAt(i + 1))) == 56320 && (r = 65536 + (r - 55296 << 10) + (n - 56320), i++), r < 128 ? t[s++] = r : (r < 2048 ? t[s++] = 192 | r >>> 6 : (r < 65536 ? t[s++] = 224 | r >>> 12 : (t[s++] = 240 | r >>> 18, t[s++] = 128 | r >>> 12 & 63), t[s++] = 128 | r >>> 6 & 63), t[s++] = 128 | 63 & r);
        return t;
      }, r.buf2binstring = function(e) {
        return l(e, e.length);
      }, r.binstring2buf = function(e) {
        for (var t = new h.Buf8(e.length), r = 0, n = t.length;r < n; r++)
          t[r] = e.charCodeAt(r);
        return t;
      }, r.buf2string = function(e, t) {
        var r, n, i, s, a = t || e.length, o = new Array(2 * a);
        for (r = n = 0;r < a; )
          if ((i = e[r++]) < 128)
            o[n++] = i;
          else if (4 < (s = u[i]))
            o[n++] = 65533, r += s - 1;
          else {
            for (i &= s === 2 ? 31 : s === 3 ? 15 : 7;1 < s && r < a; )
              i = i << 6 | 63 & e[r++], s--;
            1 < s ? o[n++] = 65533 : i < 65536 ? o[n++] = i : (i -= 65536, o[n++] = 55296 | i >> 10 & 1023, o[n++] = 56320 | 1023 & i);
          }
        return l(o, n);
      }, r.utf8border = function(e, t) {
        var r;
        for ((t = t || e.length) > e.length && (t = e.length), r = t - 1;0 <= r && (192 & e[r]) == 128; )
          r--;
        return r < 0 ? t : r === 0 ? t : r + u[e[r]] > t ? r : t;
      };
    }, { "./common": 41 }], 43: [function(e, t, r) {
      t.exports = function(e, t, r, n) {
        for (var i = 65535 & e | 0, s = e >>> 16 & 65535 | 0, a = 0;r !== 0; ) {
          for (r -= a = 2000 < r ? 2000 : r;s = s + (i = i + t[n++] | 0) | 0, --a; )
            ;
          i %= 65521, s %= 65521;
        }
        return i | s << 16 | 0;
      };
    }, {}], 44: [function(e, t, r) {
      t.exports = { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_BUF_ERROR: -5, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0, Z_BINARY: 0, Z_TEXT: 1, Z_UNKNOWN: 2, Z_DEFLATED: 8 };
    }, {}], 45: [function(e, t, r) {
      var o = function() {
        for (var e, t = [], r = 0;r < 256; r++) {
          e = r;
          for (var n = 0;n < 8; n++)
            e = 1 & e ? 3988292384 ^ e >>> 1 : e >>> 1;
          t[r] = e;
        }
        return t;
      }();
      t.exports = function(e, t, r, n) {
        var i = o, s = n + r;
        e ^= -1;
        for (var a = n;a < s; a++)
          e = e >>> 8 ^ i[255 & (e ^ t[a])];
        return -1 ^ e;
      };
    }, {}], 46: [function(e, t, r) {
      var h, c = e("../utils/common"), u = e("./trees"), d = e("./adler32"), p = e("./crc32"), n = e("./messages"), l = 0, f = 4, m = 0, _ = -2, g = -1, b = 4, i = 2, v = 8, y = 9, s = 286, a = 30, o = 19, w = 2 * s + 1, k = 15, x = 3, S = 258, z = S + x + 1, C = 42, E = 113, A = 1, I = 2, O = 3, B = 4;
      function R(e, t) {
        return e.msg = n[t], t;
      }
      function T(e) {
        return (e << 1) - (4 < e ? 9 : 0);
      }
      function D(e) {
        for (var t = e.length;0 <= --t; )
          e[t] = 0;
      }
      function F(e) {
        var t = e.state, r = t.pending;
        r > e.avail_out && (r = e.avail_out), r !== 0 && (c.arraySet(e.output, t.pending_buf, t.pending_out, r, e.next_out), e.next_out += r, t.pending_out += r, e.total_out += r, e.avail_out -= r, t.pending -= r, t.pending === 0 && (t.pending_out = 0));
      }
      function N(e, t) {
        u._tr_flush_block(e, 0 <= e.block_start ? e.block_start : -1, e.strstart - e.block_start, t), e.block_start = e.strstart, F(e.strm);
      }
      function U(e, t) {
        e.pending_buf[e.pending++] = t;
      }
      function P(e, t) {
        e.pending_buf[e.pending++] = t >>> 8 & 255, e.pending_buf[e.pending++] = 255 & t;
      }
      function L(e, t) {
        var r, n, { max_chain_length: i, strstart: s, prev_length: a, nice_match: o } = e, h = e.strstart > e.w_size - z ? e.strstart - (e.w_size - z) : 0, { window: u, w_mask: l, prev: f } = e, c = e.strstart + S, d = u[s + a - 1], p = u[s + a];
        e.prev_length >= e.good_match && (i >>= 2), o > e.lookahead && (o = e.lookahead);
        do {
          if (u[(r = t) + a] === p && u[r + a - 1] === d && u[r] === u[s] && u[++r] === u[s + 1]) {
            s += 2, r++;
            do {} while (u[++s] === u[++r] && u[++s] === u[++r] && u[++s] === u[++r] && u[++s] === u[++r] && u[++s] === u[++r] && u[++s] === u[++r] && u[++s] === u[++r] && u[++s] === u[++r] && s < c);
            if (n = S - (c - s), s = c - S, a < n) {
              if (e.match_start = t, o <= (a = n))
                break;
              d = u[s + a - 1], p = u[s + a];
            }
          }
        } while ((t = f[t & l]) > h && --i != 0);
        return a <= e.lookahead ? a : e.lookahead;
      }
      function j(e) {
        var t, r, n, i, s, a, o, h, u, l, f = e.w_size;
        do {
          if (i = e.window_size - e.lookahead - e.strstart, e.strstart >= f + (f - z)) {
            for (c.arraySet(e.window, e.window, f, f, 0), e.match_start -= f, e.strstart -= f, e.block_start -= f, t = r = e.hash_size;n = e.head[--t], e.head[t] = f <= n ? n - f : 0, --r; )
              ;
            for (t = r = f;n = e.prev[--t], e.prev[t] = f <= n ? n - f : 0, --r; )
              ;
            i += f;
          }
          if (e.strm.avail_in === 0)
            break;
          if (a = e.strm, o = e.window, h = e.strstart + e.lookahead, u = i, l = undefined, l = a.avail_in, u < l && (l = u), r = l === 0 ? 0 : (a.avail_in -= l, c.arraySet(o, a.input, a.next_in, l, h), a.state.wrap === 1 ? a.adler = d(a.adler, o, l, h) : a.state.wrap === 2 && (a.adler = p(a.adler, o, l, h)), a.next_in += l, a.total_in += l, l), e.lookahead += r, e.lookahead + e.insert >= x)
            for (s = e.strstart - e.insert, e.ins_h = e.window[s], e.ins_h = (e.ins_h << e.hash_shift ^ e.window[s + 1]) & e.hash_mask;e.insert && (e.ins_h = (e.ins_h << e.hash_shift ^ e.window[s + x - 1]) & e.hash_mask, e.prev[s & e.w_mask] = e.head[e.ins_h], e.head[e.ins_h] = s, s++, e.insert--, !(e.lookahead + e.insert < x)); )
              ;
        } while (e.lookahead < z && e.strm.avail_in !== 0);
      }
      function Z(e, t) {
        for (var r, n;; ) {
          if (e.lookahead < z) {
            if (j(e), e.lookahead < z && t === l)
              return A;
            if (e.lookahead === 0)
              break;
          }
          if (r = 0, e.lookahead >= x && (e.ins_h = (e.ins_h << e.hash_shift ^ e.window[e.strstart + x - 1]) & e.hash_mask, r = e.prev[e.strstart & e.w_mask] = e.head[e.ins_h], e.head[e.ins_h] = e.strstart), r !== 0 && e.strstart - r <= e.w_size - z && (e.match_length = L(e, r)), e.match_length >= x)
            if (n = u._tr_tally(e, e.strstart - e.match_start, e.match_length - x), e.lookahead -= e.match_length, e.match_length <= e.max_lazy_match && e.lookahead >= x) {
              for (e.match_length--;e.strstart++, e.ins_h = (e.ins_h << e.hash_shift ^ e.window[e.strstart + x - 1]) & e.hash_mask, r = e.prev[e.strstart & e.w_mask] = e.head[e.ins_h], e.head[e.ins_h] = e.strstart, --e.match_length != 0; )
                ;
              e.strstart++;
            } else
              e.strstart += e.match_length, e.match_length = 0, e.ins_h = e.window[e.strstart], e.ins_h = (e.ins_h << e.hash_shift ^ e.window[e.strstart + 1]) & e.hash_mask;
          else
            n = u._tr_tally(e, 0, e.window[e.strstart]), e.lookahead--, e.strstart++;
          if (n && (N(e, false), e.strm.avail_out === 0))
            return A;
        }
        return e.insert = e.strstart < x - 1 ? e.strstart : x - 1, t === f ? (N(e, true), e.strm.avail_out === 0 ? O : B) : e.last_lit && (N(e, false), e.strm.avail_out === 0) ? A : I;
      }
      function W(e, t) {
        for (var r, n, i;; ) {
          if (e.lookahead < z) {
            if (j(e), e.lookahead < z && t === l)
              return A;
            if (e.lookahead === 0)
              break;
          }
          if (r = 0, e.lookahead >= x && (e.ins_h = (e.ins_h << e.hash_shift ^ e.window[e.strstart + x - 1]) & e.hash_mask, r = e.prev[e.strstart & e.w_mask] = e.head[e.ins_h], e.head[e.ins_h] = e.strstart), e.prev_length = e.match_length, e.prev_match = e.match_start, e.match_length = x - 1, r !== 0 && e.prev_length < e.max_lazy_match && e.strstart - r <= e.w_size - z && (e.match_length = L(e, r), e.match_length <= 5 && (e.strategy === 1 || e.match_length === x && 4096 < e.strstart - e.match_start) && (e.match_length = x - 1)), e.prev_length >= x && e.match_length <= e.prev_length) {
            for (i = e.strstart + e.lookahead - x, n = u._tr_tally(e, e.strstart - 1 - e.prev_match, e.prev_length - x), e.lookahead -= e.prev_length - 1, e.prev_length -= 2;++e.strstart <= i && (e.ins_h = (e.ins_h << e.hash_shift ^ e.window[e.strstart + x - 1]) & e.hash_mask, r = e.prev[e.strstart & e.w_mask] = e.head[e.ins_h], e.head[e.ins_h] = e.strstart), --e.prev_length != 0; )
              ;
            if (e.match_available = 0, e.match_length = x - 1, e.strstart++, n && (N(e, false), e.strm.avail_out === 0))
              return A;
          } else if (e.match_available) {
            if ((n = u._tr_tally(e, 0, e.window[e.strstart - 1])) && N(e, false), e.strstart++, e.lookahead--, e.strm.avail_out === 0)
              return A;
          } else
            e.match_available = 1, e.strstart++, e.lookahead--;
        }
        return e.match_available && (n = u._tr_tally(e, 0, e.window[e.strstart - 1]), e.match_available = 0), e.insert = e.strstart < x - 1 ? e.strstart : x - 1, t === f ? (N(e, true), e.strm.avail_out === 0 ? O : B) : e.last_lit && (N(e, false), e.strm.avail_out === 0) ? A : I;
      }
      function M(e, t, r, n, i) {
        this.good_length = e, this.max_lazy = t, this.nice_length = r, this.max_chain = n, this.func = i;
      }
      function H() {
        this.strm = null, this.status = 0, this.pending_buf = null, this.pending_buf_size = 0, this.pending_out = 0, this.pending = 0, this.wrap = 0, this.gzhead = null, this.gzindex = 0, this.method = v, this.last_flush = -1, this.w_size = 0, this.w_bits = 0, this.w_mask = 0, this.window = null, this.window_size = 0, this.prev = null, this.head = null, this.ins_h = 0, this.hash_size = 0, this.hash_bits = 0, this.hash_mask = 0, this.hash_shift = 0, this.block_start = 0, this.match_length = 0, this.prev_match = 0, this.match_available = 0, this.strstart = 0, this.match_start = 0, this.lookahead = 0, this.prev_length = 0, this.max_chain_length = 0, this.max_lazy_match = 0, this.level = 0, this.strategy = 0, this.good_match = 0, this.nice_match = 0, this.dyn_ltree = new c.Buf16(2 * w), this.dyn_dtree = new c.Buf16(2 * (2 * a + 1)), this.bl_tree = new c.Buf16(2 * (2 * o + 1)), D(this.dyn_ltree), D(this.dyn_dtree), D(this.bl_tree), this.l_desc = null, this.d_desc = null, this.bl_desc = null, this.bl_count = new c.Buf16(k + 1), this.heap = new c.Buf16(2 * s + 1), D(this.heap), this.heap_len = 0, this.heap_max = 0, this.depth = new c.Buf16(2 * s + 1), D(this.depth), this.l_buf = 0, this.lit_bufsize = 0, this.last_lit = 0, this.d_buf = 0, this.opt_len = 0, this.static_len = 0, this.matches = 0, this.insert = 0, this.bi_buf = 0, this.bi_valid = 0;
      }
      function G(e) {
        var t;
        return e && e.state ? (e.total_in = e.total_out = 0, e.data_type = i, (t = e.state).pending = 0, t.pending_out = 0, t.wrap < 0 && (t.wrap = -t.wrap), t.status = t.wrap ? C : E, e.adler = t.wrap === 2 ? 0 : 1, t.last_flush = l, u._tr_init(t), m) : R(e, _);
      }
      function K(e) {
        var t = G(e);
        return t === m && function(e) {
          e.window_size = 2 * e.w_size, D(e.head), e.max_lazy_match = h[e.level].max_lazy, e.good_match = h[e.level].good_length, e.nice_match = h[e.level].nice_length, e.max_chain_length = h[e.level].max_chain, e.strstart = 0, e.block_start = 0, e.lookahead = 0, e.insert = 0, e.match_length = e.prev_length = x - 1, e.match_available = 0, e.ins_h = 0;
        }(e.state), t;
      }
      function Y(e, t, r, n, i, s) {
        if (!e)
          return _;
        var a = 1;
        if (t === g && (t = 6), n < 0 ? (a = 0, n = -n) : 15 < n && (a = 2, n -= 16), i < 1 || y < i || r !== v || n < 8 || 15 < n || t < 0 || 9 < t || s < 0 || b < s)
          return R(e, _);
        n === 8 && (n = 9);
        var o = new H;
        return (e.state = o).strm = e, o.wrap = a, o.gzhead = null, o.w_bits = n, o.w_size = 1 << o.w_bits, o.w_mask = o.w_size - 1, o.hash_bits = i + 7, o.hash_size = 1 << o.hash_bits, o.hash_mask = o.hash_size - 1, o.hash_shift = ~~((o.hash_bits + x - 1) / x), o.window = new c.Buf8(2 * o.w_size), o.head = new c.Buf16(o.hash_size), o.prev = new c.Buf16(o.w_size), o.lit_bufsize = 1 << i + 6, o.pending_buf_size = 4 * o.lit_bufsize, o.pending_buf = new c.Buf8(o.pending_buf_size), o.d_buf = 1 * o.lit_bufsize, o.l_buf = 3 * o.lit_bufsize, o.level = t, o.strategy = s, o.method = r, K(e);
      }
      h = [new M(0, 0, 0, 0, function(e, t) {
        var r = 65535;
        for (r > e.pending_buf_size - 5 && (r = e.pending_buf_size - 5);; ) {
          if (e.lookahead <= 1) {
            if (j(e), e.lookahead === 0 && t === l)
              return A;
            if (e.lookahead === 0)
              break;
          }
          e.strstart += e.lookahead, e.lookahead = 0;
          var n = e.block_start + r;
          if ((e.strstart === 0 || e.strstart >= n) && (e.lookahead = e.strstart - n, e.strstart = n, N(e, false), e.strm.avail_out === 0))
            return A;
          if (e.strstart - e.block_start >= e.w_size - z && (N(e, false), e.strm.avail_out === 0))
            return A;
        }
        return e.insert = 0, t === f ? (N(e, true), e.strm.avail_out === 0 ? O : B) : (e.strstart > e.block_start && (N(e, false), e.strm.avail_out), A);
      }), new M(4, 4, 8, 4, Z), new M(4, 5, 16, 8, Z), new M(4, 6, 32, 32, Z), new M(4, 4, 16, 16, W), new M(8, 16, 32, 32, W), new M(8, 16, 128, 128, W), new M(8, 32, 128, 256, W), new M(32, 128, 258, 1024, W), new M(32, 258, 258, 4096, W)], r.deflateInit = function(e, t) {
        return Y(e, t, v, 15, 8, 0);
      }, r.deflateInit2 = Y, r.deflateReset = K, r.deflateResetKeep = G, r.deflateSetHeader = function(e, t) {
        return e && e.state ? e.state.wrap !== 2 ? _ : (e.state.gzhead = t, m) : _;
      }, r.deflate = function(e, t) {
        var r, n, i, s;
        if (!e || !e.state || 5 < t || t < 0)
          return e ? R(e, _) : _;
        if (n = e.state, !e.output || !e.input && e.avail_in !== 0 || n.status === 666 && t !== f)
          return R(e, e.avail_out === 0 ? -5 : _);
        if (n.strm = e, r = n.last_flush, n.last_flush = t, n.status === C)
          if (n.wrap === 2)
            e.adler = 0, U(n, 31), U(n, 139), U(n, 8), n.gzhead ? (U(n, (n.gzhead.text ? 1 : 0) + (n.gzhead.hcrc ? 2 : 0) + (n.gzhead.extra ? 4 : 0) + (n.gzhead.name ? 8 : 0) + (n.gzhead.comment ? 16 : 0)), U(n, 255 & n.gzhead.time), U(n, n.gzhead.time >> 8 & 255), U(n, n.gzhead.time >> 16 & 255), U(n, n.gzhead.time >> 24 & 255), U(n, n.level === 9 ? 2 : 2 <= n.strategy || n.level < 2 ? 4 : 0), U(n, 255 & n.gzhead.os), n.gzhead.extra && n.gzhead.extra.length && (U(n, 255 & n.gzhead.extra.length), U(n, n.gzhead.extra.length >> 8 & 255)), n.gzhead.hcrc && (e.adler = p(e.adler, n.pending_buf, n.pending, 0)), n.gzindex = 0, n.status = 69) : (U(n, 0), U(n, 0), U(n, 0), U(n, 0), U(n, 0), U(n, n.level === 9 ? 2 : 2 <= n.strategy || n.level < 2 ? 4 : 0), U(n, 3), n.status = E);
          else {
            var a = v + (n.w_bits - 8 << 4) << 8;
            a |= (2 <= n.strategy || n.level < 2 ? 0 : n.level < 6 ? 1 : n.level === 6 ? 2 : 3) << 6, n.strstart !== 0 && (a |= 32), a += 31 - a % 31, n.status = E, P(n, a), n.strstart !== 0 && (P(n, e.adler >>> 16), P(n, 65535 & e.adler)), e.adler = 1;
          }
        if (n.status === 69)
          if (n.gzhead.extra) {
            for (i = n.pending;n.gzindex < (65535 & n.gzhead.extra.length) && (n.pending !== n.pending_buf_size || (n.gzhead.hcrc && n.pending > i && (e.adler = p(e.adler, n.pending_buf, n.pending - i, i)), F(e), i = n.pending, n.pending !== n.pending_buf_size)); )
              U(n, 255 & n.gzhead.extra[n.gzindex]), n.gzindex++;
            n.gzhead.hcrc && n.pending > i && (e.adler = p(e.adler, n.pending_buf, n.pending - i, i)), n.gzindex === n.gzhead.extra.length && (n.gzindex = 0, n.status = 73);
          } else
            n.status = 73;
        if (n.status === 73)
          if (n.gzhead.name) {
            i = n.pending;
            do {
              if (n.pending === n.pending_buf_size && (n.gzhead.hcrc && n.pending > i && (e.adler = p(e.adler, n.pending_buf, n.pending - i, i)), F(e), i = n.pending, n.pending === n.pending_buf_size)) {
                s = 1;
                break;
              }
              s = n.gzindex < n.gzhead.name.length ? 255 & n.gzhead.name.charCodeAt(n.gzindex++) : 0, U(n, s);
            } while (s !== 0);
            n.gzhead.hcrc && n.pending > i && (e.adler = p(e.adler, n.pending_buf, n.pending - i, i)), s === 0 && (n.gzindex = 0, n.status = 91);
          } else
            n.status = 91;
        if (n.status === 91)
          if (n.gzhead.comment) {
            i = n.pending;
            do {
              if (n.pending === n.pending_buf_size && (n.gzhead.hcrc && n.pending > i && (e.adler = p(e.adler, n.pending_buf, n.pending - i, i)), F(e), i = n.pending, n.pending === n.pending_buf_size)) {
                s = 1;
                break;
              }
              s = n.gzindex < n.gzhead.comment.length ? 255 & n.gzhead.comment.charCodeAt(n.gzindex++) : 0, U(n, s);
            } while (s !== 0);
            n.gzhead.hcrc && n.pending > i && (e.adler = p(e.adler, n.pending_buf, n.pending - i, i)), s === 0 && (n.status = 103);
          } else
            n.status = 103;
        if (n.status === 103 && (n.gzhead.hcrc ? (n.pending + 2 > n.pending_buf_size && F(e), n.pending + 2 <= n.pending_buf_size && (U(n, 255 & e.adler), U(n, e.adler >> 8 & 255), e.adler = 0, n.status = E)) : n.status = E), n.pending !== 0) {
          if (F(e), e.avail_out === 0)
            return n.last_flush = -1, m;
        } else if (e.avail_in === 0 && T(t) <= T(r) && t !== f)
          return R(e, -5);
        if (n.status === 666 && e.avail_in !== 0)
          return R(e, -5);
        if (e.avail_in !== 0 || n.lookahead !== 0 || t !== l && n.status !== 666) {
          var o = n.strategy === 2 ? function(e, t) {
            for (var r;; ) {
              if (e.lookahead === 0 && (j(e), e.lookahead === 0)) {
                if (t === l)
                  return A;
                break;
              }
              if (e.match_length = 0, r = u._tr_tally(e, 0, e.window[e.strstart]), e.lookahead--, e.strstart++, r && (N(e, false), e.strm.avail_out === 0))
                return A;
            }
            return e.insert = 0, t === f ? (N(e, true), e.strm.avail_out === 0 ? O : B) : e.last_lit && (N(e, false), e.strm.avail_out === 0) ? A : I;
          }(n, t) : n.strategy === 3 ? function(e, t) {
            for (var r, n, i, s, a = e.window;; ) {
              if (e.lookahead <= S) {
                if (j(e), e.lookahead <= S && t === l)
                  return A;
                if (e.lookahead === 0)
                  break;
              }
              if (e.match_length = 0, e.lookahead >= x && 0 < e.strstart && (n = a[i = e.strstart - 1]) === a[++i] && n === a[++i] && n === a[++i]) {
                s = e.strstart + S;
                do {} while (n === a[++i] && n === a[++i] && n === a[++i] && n === a[++i] && n === a[++i] && n === a[++i] && n === a[++i] && n === a[++i] && i < s);
                e.match_length = S - (s - i), e.match_length > e.lookahead && (e.match_length = e.lookahead);
              }
              if (e.match_length >= x ? (r = u._tr_tally(e, 1, e.match_length - x), e.lookahead -= e.match_length, e.strstart += e.match_length, e.match_length = 0) : (r = u._tr_tally(e, 0, e.window[e.strstart]), e.lookahead--, e.strstart++), r && (N(e, false), e.strm.avail_out === 0))
                return A;
            }
            return e.insert = 0, t === f ? (N(e, true), e.strm.avail_out === 0 ? O : B) : e.last_lit && (N(e, false), e.strm.avail_out === 0) ? A : I;
          }(n, t) : h[n.level].func(n, t);
          if (o !== O && o !== B || (n.status = 666), o === A || o === O)
            return e.avail_out === 0 && (n.last_flush = -1), m;
          if (o === I && (t === 1 ? u._tr_align(n) : t !== 5 && (u._tr_stored_block(n, 0, 0, false), t === 3 && (D(n.head), n.lookahead === 0 && (n.strstart = 0, n.block_start = 0, n.insert = 0))), F(e), e.avail_out === 0))
            return n.last_flush = -1, m;
        }
        return t !== f ? m : n.wrap <= 0 ? 1 : (n.wrap === 2 ? (U(n, 255 & e.adler), U(n, e.adler >> 8 & 255), U(n, e.adler >> 16 & 255), U(n, e.adler >> 24 & 255), U(n, 255 & e.total_in), U(n, e.total_in >> 8 & 255), U(n, e.total_in >> 16 & 255), U(n, e.total_in >> 24 & 255)) : (P(n, e.adler >>> 16), P(n, 65535 & e.adler)), F(e), 0 < n.wrap && (n.wrap = -n.wrap), n.pending !== 0 ? m : 1);
      }, r.deflateEnd = function(e) {
        var t;
        return e && e.state ? (t = e.state.status) !== C && t !== 69 && t !== 73 && t !== 91 && t !== 103 && t !== E && t !== 666 ? R(e, _) : (e.state = null, t === E ? R(e, -3) : m) : _;
      }, r.deflateSetDictionary = function(e, t) {
        var r, n, i, s, a, o, h, u, l = t.length;
        if (!e || !e.state)
          return _;
        if ((s = (r = e.state).wrap) === 2 || s === 1 && r.status !== C || r.lookahead)
          return _;
        for (s === 1 && (e.adler = d(e.adler, t, l, 0)), r.wrap = 0, l >= r.w_size && (s === 0 && (D(r.head), r.strstart = 0, r.block_start = 0, r.insert = 0), u = new c.Buf8(r.w_size), c.arraySet(u, t, l - r.w_size, r.w_size, 0), t = u, l = r.w_size), a = e.avail_in, o = e.next_in, h = e.input, e.avail_in = l, e.next_in = 0, e.input = t, j(r);r.lookahead >= x; ) {
          for (n = r.strstart, i = r.lookahead - (x - 1);r.ins_h = (r.ins_h << r.hash_shift ^ r.window[n + x - 1]) & r.hash_mask, r.prev[n & r.w_mask] = r.head[r.ins_h], r.head[r.ins_h] = n, n++, --i; )
            ;
          r.strstart = n, r.lookahead = x - 1, j(r);
        }
        return r.strstart += r.lookahead, r.block_start = r.strstart, r.insert = r.lookahead, r.lookahead = 0, r.match_length = r.prev_length = x - 1, r.match_available = 0, e.next_in = o, e.input = h, e.avail_in = a, r.wrap = s, m;
      }, r.deflateInfo = "pako deflate (from Nodeca project)";
    }, { "../utils/common": 41, "./adler32": 43, "./crc32": 45, "./messages": 51, "./trees": 52 }], 47: [function(e, t, r) {
      t.exports = function() {
        this.text = 0, this.time = 0, this.xflags = 0, this.os = 0, this.extra = null, this.extra_len = 0, this.name = "", this.comment = "", this.hcrc = 0, this.done = false;
      };
    }, {}], 48: [function(e, t, r) {
      t.exports = function(e, t) {
        var r, n, i, s, a, o, h, u, l, f, c, d, p, m, _, g, b, v, y, w, k, x, S, z, C;
        r = e.state, n = e.next_in, z = e.input, i = n + (e.avail_in - 5), s = e.next_out, C = e.output, a = s - (t - e.avail_out), o = s + (e.avail_out - 257), h = r.dmax, u = r.wsize, l = r.whave, f = r.wnext, c = r.window, d = r.hold, p = r.bits, m = r.lencode, _ = r.distcode, g = (1 << r.lenbits) - 1, b = (1 << r.distbits) - 1;
        e:
          do {
            p < 15 && (d += z[n++] << p, p += 8, d += z[n++] << p, p += 8), v = m[d & g];
            t:
              for (;; ) {
                if (d >>>= y = v >>> 24, p -= y, (y = v >>> 16 & 255) === 0)
                  C[s++] = 65535 & v;
                else {
                  if (!(16 & y)) {
                    if ((64 & y) == 0) {
                      v = m[(65535 & v) + (d & (1 << y) - 1)];
                      continue t;
                    }
                    if (32 & y) {
                      r.mode = 12;
                      break e;
                    }
                    e.msg = "invalid literal/length code", r.mode = 30;
                    break e;
                  }
                  w = 65535 & v, (y &= 15) && (p < y && (d += z[n++] << p, p += 8), w += d & (1 << y) - 1, d >>>= y, p -= y), p < 15 && (d += z[n++] << p, p += 8, d += z[n++] << p, p += 8), v = _[d & b];
                  r:
                    for (;; ) {
                      if (d >>>= y = v >>> 24, p -= y, !(16 & (y = v >>> 16 & 255))) {
                        if ((64 & y) == 0) {
                          v = _[(65535 & v) + (d & (1 << y) - 1)];
                          continue r;
                        }
                        e.msg = "invalid distance code", r.mode = 30;
                        break e;
                      }
                      if (k = 65535 & v, p < (y &= 15) && (d += z[n++] << p, (p += 8) < y && (d += z[n++] << p, p += 8)), h < (k += d & (1 << y) - 1)) {
                        e.msg = "invalid distance too far back", r.mode = 30;
                        break e;
                      }
                      if (d >>>= y, p -= y, (y = s - a) < k) {
                        if (l < (y = k - y) && r.sane) {
                          e.msg = "invalid distance too far back", r.mode = 30;
                          break e;
                        }
                        if (S = c, (x = 0) === f) {
                          if (x += u - y, y < w) {
                            for (w -= y;C[s++] = c[x++], --y; )
                              ;
                            x = s - k, S = C;
                          }
                        } else if (f < y) {
                          if (x += u + f - y, (y -= f) < w) {
                            for (w -= y;C[s++] = c[x++], --y; )
                              ;
                            if (x = 0, f < w) {
                              for (w -= y = f;C[s++] = c[x++], --y; )
                                ;
                              x = s - k, S = C;
                            }
                          }
                        } else if (x += f - y, y < w) {
                          for (w -= y;C[s++] = c[x++], --y; )
                            ;
                          x = s - k, S = C;
                        }
                        for (;2 < w; )
                          C[s++] = S[x++], C[s++] = S[x++], C[s++] = S[x++], w -= 3;
                        w && (C[s++] = S[x++], 1 < w && (C[s++] = S[x++]));
                      } else {
                        for (x = s - k;C[s++] = C[x++], C[s++] = C[x++], C[s++] = C[x++], 2 < (w -= 3); )
                          ;
                        w && (C[s++] = C[x++], 1 < w && (C[s++] = C[x++]));
                      }
                      break;
                    }
                }
                break;
              }
          } while (n < i && s < o);
        n -= w = p >> 3, d &= (1 << (p -= w << 3)) - 1, e.next_in = n, e.next_out = s, e.avail_in = n < i ? i - n + 5 : 5 - (n - i), e.avail_out = s < o ? o - s + 257 : 257 - (s - o), r.hold = d, r.bits = p;
      };
    }, {}], 49: [function(e, t, r) {
      var I = e("../utils/common"), O = e("./adler32"), B = e("./crc32"), R = e("./inffast"), T = e("./inftrees"), D = 1, F = 2, N = 0, U = -2, P = 1, n = 852, i = 592;
      function L(e) {
        return (e >>> 24 & 255) + (e >>> 8 & 65280) + ((65280 & e) << 8) + ((255 & e) << 24);
      }
      function s() {
        this.mode = 0, this.last = false, this.wrap = 0, this.havedict = false, this.flags = 0, this.dmax = 0, this.check = 0, this.total = 0, this.head = null, this.wbits = 0, this.wsize = 0, this.whave = 0, this.wnext = 0, this.window = null, this.hold = 0, this.bits = 0, this.length = 0, this.offset = 0, this.extra = 0, this.lencode = null, this.distcode = null, this.lenbits = 0, this.distbits = 0, this.ncode = 0, this.nlen = 0, this.ndist = 0, this.have = 0, this.next = null, this.lens = new I.Buf16(320), this.work = new I.Buf16(288), this.lendyn = null, this.distdyn = null, this.sane = 0, this.back = 0, this.was = 0;
      }
      function a(e) {
        var t;
        return e && e.state ? (t = e.state, e.total_in = e.total_out = t.total = 0, e.msg = "", t.wrap && (e.adler = 1 & t.wrap), t.mode = P, t.last = 0, t.havedict = 0, t.dmax = 32768, t.head = null, t.hold = 0, t.bits = 0, t.lencode = t.lendyn = new I.Buf32(n), t.distcode = t.distdyn = new I.Buf32(i), t.sane = 1, t.back = -1, N) : U;
      }
      function o(e) {
        var t;
        return e && e.state ? ((t = e.state).wsize = 0, t.whave = 0, t.wnext = 0, a(e)) : U;
      }
      function h(e, t) {
        var r, n;
        return e && e.state ? (n = e.state, t < 0 ? (r = 0, t = -t) : (r = 1 + (t >> 4), t < 48 && (t &= 15)), t && (t < 8 || 15 < t) ? U : (n.window !== null && n.wbits !== t && (n.window = null), n.wrap = r, n.wbits = t, o(e))) : U;
      }
      function u(e, t) {
        var r, n;
        return e ? (n = new s, (e.state = n).window = null, (r = h(e, t)) !== N && (e.state = null), r) : U;
      }
      var l, f, c = true;
      function j(e) {
        if (c) {
          var t;
          for (l = new I.Buf32(512), f = new I.Buf32(32), t = 0;t < 144; )
            e.lens[t++] = 8;
          for (;t < 256; )
            e.lens[t++] = 9;
          for (;t < 280; )
            e.lens[t++] = 7;
          for (;t < 288; )
            e.lens[t++] = 8;
          for (T(D, e.lens, 0, 288, l, 0, e.work, { bits: 9 }), t = 0;t < 32; )
            e.lens[t++] = 5;
          T(F, e.lens, 0, 32, f, 0, e.work, { bits: 5 }), c = false;
        }
        e.lencode = l, e.lenbits = 9, e.distcode = f, e.distbits = 5;
      }
      function Z(e, t, r, n) {
        var i, s = e.state;
        return s.window === null && (s.wsize = 1 << s.wbits, s.wnext = 0, s.whave = 0, s.window = new I.Buf8(s.wsize)), n >= s.wsize ? (I.arraySet(s.window, t, r - s.wsize, s.wsize, 0), s.wnext = 0, s.whave = s.wsize) : (n < (i = s.wsize - s.wnext) && (i = n), I.arraySet(s.window, t, r - n, i, s.wnext), (n -= i) ? (I.arraySet(s.window, t, r - n, n, 0), s.wnext = n, s.whave = s.wsize) : (s.wnext += i, s.wnext === s.wsize && (s.wnext = 0), s.whave < s.wsize && (s.whave += i))), 0;
      }
      r.inflateReset = o, r.inflateReset2 = h, r.inflateResetKeep = a, r.inflateInit = function(e) {
        return u(e, 15);
      }, r.inflateInit2 = u, r.inflate = function(e, t) {
        var r, n, i, s, a, o, h, u, l, f, c, d, p, m, _, g, b, v, y, w, k, x, S, z, C = 0, E = new I.Buf8(4), A = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        if (!e || !e.state || !e.output || !e.input && e.avail_in !== 0)
          return U;
        (r = e.state).mode === 12 && (r.mode = 13), a = e.next_out, i = e.output, h = e.avail_out, s = e.next_in, n = e.input, o = e.avail_in, u = r.hold, l = r.bits, f = o, c = h, x = N;
        e:
          for (;; )
            switch (r.mode) {
              case P:
                if (r.wrap === 0) {
                  r.mode = 13;
                  break;
                }
                for (;l < 16; ) {
                  if (o === 0)
                    break e;
                  o--, u += n[s++] << l, l += 8;
                }
                if (2 & r.wrap && u === 35615) {
                  E[r.check = 0] = 255 & u, E[1] = u >>> 8 & 255, r.check = B(r.check, E, 2, 0), l = u = 0, r.mode = 2;
                  break;
                }
                if (r.flags = 0, r.head && (r.head.done = false), !(1 & r.wrap) || (((255 & u) << 8) + (u >> 8)) % 31) {
                  e.msg = "incorrect header check", r.mode = 30;
                  break;
                }
                if ((15 & u) != 8) {
                  e.msg = "unknown compression method", r.mode = 30;
                  break;
                }
                if (l -= 4, k = 8 + (15 & (u >>>= 4)), r.wbits === 0)
                  r.wbits = k;
                else if (k > r.wbits) {
                  e.msg = "invalid window size", r.mode = 30;
                  break;
                }
                r.dmax = 1 << k, e.adler = r.check = 1, r.mode = 512 & u ? 10 : 12, l = u = 0;
                break;
              case 2:
                for (;l < 16; ) {
                  if (o === 0)
                    break e;
                  o--, u += n[s++] << l, l += 8;
                }
                if (r.flags = u, (255 & r.flags) != 8) {
                  e.msg = "unknown compression method", r.mode = 30;
                  break;
                }
                if (57344 & r.flags) {
                  e.msg = "unknown header flags set", r.mode = 30;
                  break;
                }
                r.head && (r.head.text = u >> 8 & 1), 512 & r.flags && (E[0] = 255 & u, E[1] = u >>> 8 & 255, r.check = B(r.check, E, 2, 0)), l = u = 0, r.mode = 3;
              case 3:
                for (;l < 32; ) {
                  if (o === 0)
                    break e;
                  o--, u += n[s++] << l, l += 8;
                }
                r.head && (r.head.time = u), 512 & r.flags && (E[0] = 255 & u, E[1] = u >>> 8 & 255, E[2] = u >>> 16 & 255, E[3] = u >>> 24 & 255, r.check = B(r.check, E, 4, 0)), l = u = 0, r.mode = 4;
              case 4:
                for (;l < 16; ) {
                  if (o === 0)
                    break e;
                  o--, u += n[s++] << l, l += 8;
                }
                r.head && (r.head.xflags = 255 & u, r.head.os = u >> 8), 512 & r.flags && (E[0] = 255 & u, E[1] = u >>> 8 & 255, r.check = B(r.check, E, 2, 0)), l = u = 0, r.mode = 5;
              case 5:
                if (1024 & r.flags) {
                  for (;l < 16; ) {
                    if (o === 0)
                      break e;
                    o--, u += n[s++] << l, l += 8;
                  }
                  r.length = u, r.head && (r.head.extra_len = u), 512 & r.flags && (E[0] = 255 & u, E[1] = u >>> 8 & 255, r.check = B(r.check, E, 2, 0)), l = u = 0;
                } else
                  r.head && (r.head.extra = null);
                r.mode = 6;
              case 6:
                if (1024 & r.flags && (o < (d = r.length) && (d = o), d && (r.head && (k = r.head.extra_len - r.length, r.head.extra || (r.head.extra = new Array(r.head.extra_len)), I.arraySet(r.head.extra, n, s, d, k)), 512 & r.flags && (r.check = B(r.check, n, d, s)), o -= d, s += d, r.length -= d), r.length))
                  break e;
                r.length = 0, r.mode = 7;
              case 7:
                if (2048 & r.flags) {
                  if (o === 0)
                    break e;
                  for (d = 0;k = n[s + d++], r.head && k && r.length < 65536 && (r.head.name += String.fromCharCode(k)), k && d < o; )
                    ;
                  if (512 & r.flags && (r.check = B(r.check, n, d, s)), o -= d, s += d, k)
                    break e;
                } else
                  r.head && (r.head.name = null);
                r.length = 0, r.mode = 8;
              case 8:
                if (4096 & r.flags) {
                  if (o === 0)
                    break e;
                  for (d = 0;k = n[s + d++], r.head && k && r.length < 65536 && (r.head.comment += String.fromCharCode(k)), k && d < o; )
                    ;
                  if (512 & r.flags && (r.check = B(r.check, n, d, s)), o -= d, s += d, k)
                    break e;
                } else
                  r.head && (r.head.comment = null);
                r.mode = 9;
              case 9:
                if (512 & r.flags) {
                  for (;l < 16; ) {
                    if (o === 0)
                      break e;
                    o--, u += n[s++] << l, l += 8;
                  }
                  if (u !== (65535 & r.check)) {
                    e.msg = "header crc mismatch", r.mode = 30;
                    break;
                  }
                  l = u = 0;
                }
                r.head && (r.head.hcrc = r.flags >> 9 & 1, r.head.done = true), e.adler = r.check = 0, r.mode = 12;
                break;
              case 10:
                for (;l < 32; ) {
                  if (o === 0)
                    break e;
                  o--, u += n[s++] << l, l += 8;
                }
                e.adler = r.check = L(u), l = u = 0, r.mode = 11;
              case 11:
                if (r.havedict === 0)
                  return e.next_out = a, e.avail_out = h, e.next_in = s, e.avail_in = o, r.hold = u, r.bits = l, 2;
                e.adler = r.check = 1, r.mode = 12;
              case 12:
                if (t === 5 || t === 6)
                  break e;
              case 13:
                if (r.last) {
                  u >>>= 7 & l, l -= 7 & l, r.mode = 27;
                  break;
                }
                for (;l < 3; ) {
                  if (o === 0)
                    break e;
                  o--, u += n[s++] << l, l += 8;
                }
                switch (r.last = 1 & u, l -= 1, 3 & (u >>>= 1)) {
                  case 0:
                    r.mode = 14;
                    break;
                  case 1:
                    if (j(r), r.mode = 20, t !== 6)
                      break;
                    u >>>= 2, l -= 2;
                    break e;
                  case 2:
                    r.mode = 17;
                    break;
                  case 3:
                    e.msg = "invalid block type", r.mode = 30;
                }
                u >>>= 2, l -= 2;
                break;
              case 14:
                for (u >>>= 7 & l, l -= 7 & l;l < 32; ) {
                  if (o === 0)
                    break e;
                  o--, u += n[s++] << l, l += 8;
                }
                if ((65535 & u) != (u >>> 16 ^ 65535)) {
                  e.msg = "invalid stored block lengths", r.mode = 30;
                  break;
                }
                if (r.length = 65535 & u, l = u = 0, r.mode = 15, t === 6)
                  break e;
              case 15:
                r.mode = 16;
              case 16:
                if (d = r.length) {
                  if (o < d && (d = o), h < d && (d = h), d === 0)
                    break e;
                  I.arraySet(i, n, s, d, a), o -= d, s += d, h -= d, a += d, r.length -= d;
                  break;
                }
                r.mode = 12;
                break;
              case 17:
                for (;l < 14; ) {
                  if (o === 0)
                    break e;
                  o--, u += n[s++] << l, l += 8;
                }
                if (r.nlen = 257 + (31 & u), u >>>= 5, l -= 5, r.ndist = 1 + (31 & u), u >>>= 5, l -= 5, r.ncode = 4 + (15 & u), u >>>= 4, l -= 4, 286 < r.nlen || 30 < r.ndist) {
                  e.msg = "too many length or distance symbols", r.mode = 30;
                  break;
                }
                r.have = 0, r.mode = 18;
              case 18:
                for (;r.have < r.ncode; ) {
                  for (;l < 3; ) {
                    if (o === 0)
                      break e;
                    o--, u += n[s++] << l, l += 8;
                  }
                  r.lens[A[r.have++]] = 7 & u, u >>>= 3, l -= 3;
                }
                for (;r.have < 19; )
                  r.lens[A[r.have++]] = 0;
                if (r.lencode = r.lendyn, r.lenbits = 7, S = { bits: r.lenbits }, x = T(0, r.lens, 0, 19, r.lencode, 0, r.work, S), r.lenbits = S.bits, x) {
                  e.msg = "invalid code lengths set", r.mode = 30;
                  break;
                }
                r.have = 0, r.mode = 19;
              case 19:
                for (;r.have < r.nlen + r.ndist; ) {
                  for (;g = (C = r.lencode[u & (1 << r.lenbits) - 1]) >>> 16 & 255, b = 65535 & C, !((_ = C >>> 24) <= l); ) {
                    if (o === 0)
                      break e;
                    o--, u += n[s++] << l, l += 8;
                  }
                  if (b < 16)
                    u >>>= _, l -= _, r.lens[r.have++] = b;
                  else {
                    if (b === 16) {
                      for (z = _ + 2;l < z; ) {
                        if (o === 0)
                          break e;
                        o--, u += n[s++] << l, l += 8;
                      }
                      if (u >>>= _, l -= _, r.have === 0) {
                        e.msg = "invalid bit length repeat", r.mode = 30;
                        break;
                      }
                      k = r.lens[r.have - 1], d = 3 + (3 & u), u >>>= 2, l -= 2;
                    } else if (b === 17) {
                      for (z = _ + 3;l < z; ) {
                        if (o === 0)
                          break e;
                        o--, u += n[s++] << l, l += 8;
                      }
                      l -= _, k = 0, d = 3 + (7 & (u >>>= _)), u >>>= 3, l -= 3;
                    } else {
                      for (z = _ + 7;l < z; ) {
                        if (o === 0)
                          break e;
                        o--, u += n[s++] << l, l += 8;
                      }
                      l -= _, k = 0, d = 11 + (127 & (u >>>= _)), u >>>= 7, l -= 7;
                    }
                    if (r.have + d > r.nlen + r.ndist) {
                      e.msg = "invalid bit length repeat", r.mode = 30;
                      break;
                    }
                    for (;d--; )
                      r.lens[r.have++] = k;
                  }
                }
                if (r.mode === 30)
                  break;
                if (r.lens[256] === 0) {
                  e.msg = "invalid code -- missing end-of-block", r.mode = 30;
                  break;
                }
                if (r.lenbits = 9, S = { bits: r.lenbits }, x = T(D, r.lens, 0, r.nlen, r.lencode, 0, r.work, S), r.lenbits = S.bits, x) {
                  e.msg = "invalid literal/lengths set", r.mode = 30;
                  break;
                }
                if (r.distbits = 6, r.distcode = r.distdyn, S = { bits: r.distbits }, x = T(F, r.lens, r.nlen, r.ndist, r.distcode, 0, r.work, S), r.distbits = S.bits, x) {
                  e.msg = "invalid distances set", r.mode = 30;
                  break;
                }
                if (r.mode = 20, t === 6)
                  break e;
              case 20:
                r.mode = 21;
              case 21:
                if (6 <= o && 258 <= h) {
                  e.next_out = a, e.avail_out = h, e.next_in = s, e.avail_in = o, r.hold = u, r.bits = l, R(e, c), a = e.next_out, i = e.output, h = e.avail_out, s = e.next_in, n = e.input, o = e.avail_in, u = r.hold, l = r.bits, r.mode === 12 && (r.back = -1);
                  break;
                }
                for (r.back = 0;g = (C = r.lencode[u & (1 << r.lenbits) - 1]) >>> 16 & 255, b = 65535 & C, !((_ = C >>> 24) <= l); ) {
                  if (o === 0)
                    break e;
                  o--, u += n[s++] << l, l += 8;
                }
                if (g && (240 & g) == 0) {
                  for (v = _, y = g, w = b;g = (C = r.lencode[w + ((u & (1 << v + y) - 1) >> v)]) >>> 16 & 255, b = 65535 & C, !(v + (_ = C >>> 24) <= l); ) {
                    if (o === 0)
                      break e;
                    o--, u += n[s++] << l, l += 8;
                  }
                  u >>>= v, l -= v, r.back += v;
                }
                if (u >>>= _, l -= _, r.back += _, r.length = b, g === 0) {
                  r.mode = 26;
                  break;
                }
                if (32 & g) {
                  r.back = -1, r.mode = 12;
                  break;
                }
                if (64 & g) {
                  e.msg = "invalid literal/length code", r.mode = 30;
                  break;
                }
                r.extra = 15 & g, r.mode = 22;
              case 22:
                if (r.extra) {
                  for (z = r.extra;l < z; ) {
                    if (o === 0)
                      break e;
                    o--, u += n[s++] << l, l += 8;
                  }
                  r.length += u & (1 << r.extra) - 1, u >>>= r.extra, l -= r.extra, r.back += r.extra;
                }
                r.was = r.length, r.mode = 23;
              case 23:
                for (;g = (C = r.distcode[u & (1 << r.distbits) - 1]) >>> 16 & 255, b = 65535 & C, !((_ = C >>> 24) <= l); ) {
                  if (o === 0)
                    break e;
                  o--, u += n[s++] << l, l += 8;
                }
                if ((240 & g) == 0) {
                  for (v = _, y = g, w = b;g = (C = r.distcode[w + ((u & (1 << v + y) - 1) >> v)]) >>> 16 & 255, b = 65535 & C, !(v + (_ = C >>> 24) <= l); ) {
                    if (o === 0)
                      break e;
                    o--, u += n[s++] << l, l += 8;
                  }
                  u >>>= v, l -= v, r.back += v;
                }
                if (u >>>= _, l -= _, r.back += _, 64 & g) {
                  e.msg = "invalid distance code", r.mode = 30;
                  break;
                }
                r.offset = b, r.extra = 15 & g, r.mode = 24;
              case 24:
                if (r.extra) {
                  for (z = r.extra;l < z; ) {
                    if (o === 0)
                      break e;
                    o--, u += n[s++] << l, l += 8;
                  }
                  r.offset += u & (1 << r.extra) - 1, u >>>= r.extra, l -= r.extra, r.back += r.extra;
                }
                if (r.offset > r.dmax) {
                  e.msg = "invalid distance too far back", r.mode = 30;
                  break;
                }
                r.mode = 25;
              case 25:
                if (h === 0)
                  break e;
                if (d = c - h, r.offset > d) {
                  if ((d = r.offset - d) > r.whave && r.sane) {
                    e.msg = "invalid distance too far back", r.mode = 30;
                    break;
                  }
                  p = d > r.wnext ? (d -= r.wnext, r.wsize - d) : r.wnext - d, d > r.length && (d = r.length), m = r.window;
                } else
                  m = i, p = a - r.offset, d = r.length;
                for (h < d && (d = h), h -= d, r.length -= d;i[a++] = m[p++], --d; )
                  ;
                r.length === 0 && (r.mode = 21);
                break;
              case 26:
                if (h === 0)
                  break e;
                i[a++] = r.length, h--, r.mode = 21;
                break;
              case 27:
                if (r.wrap) {
                  for (;l < 32; ) {
                    if (o === 0)
                      break e;
                    o--, u |= n[s++] << l, l += 8;
                  }
                  if (c -= h, e.total_out += c, r.total += c, c && (e.adler = r.check = r.flags ? B(r.check, i, c, a - c) : O(r.check, i, c, a - c)), c = h, (r.flags ? u : L(u)) !== r.check) {
                    e.msg = "incorrect data check", r.mode = 30;
                    break;
                  }
                  l = u = 0;
                }
                r.mode = 28;
              case 28:
                if (r.wrap && r.flags) {
                  for (;l < 32; ) {
                    if (o === 0)
                      break e;
                    o--, u += n[s++] << l, l += 8;
                  }
                  if (u !== (4294967295 & r.total)) {
                    e.msg = "incorrect length check", r.mode = 30;
                    break;
                  }
                  l = u = 0;
                }
                r.mode = 29;
              case 29:
                x = 1;
                break e;
              case 30:
                x = -3;
                break e;
              case 31:
                return -4;
              case 32:
              default:
                return U;
            }
        return e.next_out = a, e.avail_out = h, e.next_in = s, e.avail_in = o, r.hold = u, r.bits = l, (r.wsize || c !== e.avail_out && r.mode < 30 && (r.mode < 27 || t !== 4)) && Z(e, e.output, e.next_out, c - e.avail_out) ? (r.mode = 31, -4) : (f -= e.avail_in, c -= e.avail_out, e.total_in += f, e.total_out += c, r.total += c, r.wrap && c && (e.adler = r.check = r.flags ? B(r.check, i, c, e.next_out - c) : O(r.check, i, c, e.next_out - c)), e.data_type = r.bits + (r.last ? 64 : 0) + (r.mode === 12 ? 128 : 0) + (r.mode === 20 || r.mode === 15 ? 256 : 0), (f == 0 && c === 0 || t === 4) && x === N && (x = -5), x);
      }, r.inflateEnd = function(e) {
        if (!e || !e.state)
          return U;
        var t = e.state;
        return t.window && (t.window = null), e.state = null, N;
      }, r.inflateGetHeader = function(e, t) {
        var r;
        return e && e.state ? (2 & (r = e.state).wrap) == 0 ? U : ((r.head = t).done = false, N) : U;
      }, r.inflateSetDictionary = function(e, t) {
        var r, n = t.length;
        return e && e.state ? (r = e.state).wrap !== 0 && r.mode !== 11 ? U : r.mode === 11 && O(1, t, n, 0) !== r.check ? -3 : Z(e, t, n, n) ? (r.mode = 31, -4) : (r.havedict = 1, N) : U;
      }, r.inflateInfo = "pako inflate (from Nodeca project)";
    }, { "../utils/common": 41, "./adler32": 43, "./crc32": 45, "./inffast": 48, "./inftrees": 50 }], 50: [function(e, t, r) {
      var D = e("../utils/common"), F = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258, 0, 0], N = [16, 16, 16, 16, 16, 16, 16, 16, 17, 17, 17, 17, 18, 18, 18, 18, 19, 19, 19, 19, 20, 20, 20, 20, 21, 21, 21, 21, 16, 72, 78], U = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577, 0, 0], P = [16, 16, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 24, 24, 25, 25, 26, 26, 27, 27, 28, 28, 29, 29, 64, 64];
      t.exports = function(e, t, r, n, i, s, a, o) {
        var h, u, l, f, c, d, p, m, _, g = o.bits, b = 0, v = 0, y = 0, w = 0, k = 0, x = 0, S = 0, z = 0, C = 0, E = 0, A = null, I = 0, O = new D.Buf16(16), B = new D.Buf16(16), R = null, T = 0;
        for (b = 0;b <= 15; b++)
          O[b] = 0;
        for (v = 0;v < n; v++)
          O[t[r + v]]++;
        for (k = g, w = 15;1 <= w && O[w] === 0; w--)
          ;
        if (w < k && (k = w), w === 0)
          return i[s++] = 20971520, i[s++] = 20971520, o.bits = 1, 0;
        for (y = 1;y < w && O[y] === 0; y++)
          ;
        for (k < y && (k = y), b = z = 1;b <= 15; b++)
          if (z <<= 1, (z -= O[b]) < 0)
            return -1;
        if (0 < z && (e === 0 || w !== 1))
          return -1;
        for (B[1] = 0, b = 1;b < 15; b++)
          B[b + 1] = B[b] + O[b];
        for (v = 0;v < n; v++)
          t[r + v] !== 0 && (a[B[t[r + v]]++] = v);
        if (d = e === 0 ? (A = R = a, 19) : e === 1 ? (A = F, I -= 257, R = N, T -= 257, 256) : (A = U, R = P, -1), b = y, c = s, S = v = E = 0, l = -1, f = (C = 1 << (x = k)) - 1, e === 1 && 852 < C || e === 2 && 592 < C)
          return 1;
        for (;; ) {
          for (p = b - S, _ = a[v] < d ? (m = 0, a[v]) : a[v] > d ? (m = R[T + a[v]], A[I + a[v]]) : (m = 96, 0), h = 1 << b - S, y = u = 1 << x;i[c + (E >> S) + (u -= h)] = p << 24 | m << 16 | _ | 0, u !== 0; )
            ;
          for (h = 1 << b - 1;E & h; )
            h >>= 1;
          if (h !== 0 ? (E &= h - 1, E += h) : E = 0, v++, --O[b] == 0) {
            if (b === w)
              break;
            b = t[r + a[v]];
          }
          if (k < b && (E & f) !== l) {
            for (S === 0 && (S = k), c += y, z = 1 << (x = b - S);x + S < w && !((z -= O[x + S]) <= 0); )
              x++, z <<= 1;
            if (C += 1 << x, e === 1 && 852 < C || e === 2 && 592 < C)
              return 1;
            i[l = E & f] = k << 24 | x << 16 | c - s | 0;
          }
        }
        return E !== 0 && (i[c + E] = b - S << 24 | 64 << 16 | 0), o.bits = k, 0;
      };
    }, { "../utils/common": 41 }], 51: [function(e, t, r) {
      t.exports = { 2: "need dictionary", 1: "stream end", 0: "", "-1": "file error", "-2": "stream error", "-3": "data error", "-4": "insufficient memory", "-5": "buffer error", "-6": "incompatible version" };
    }, {}], 52: [function(e, t, r) {
      var i = e("../utils/common"), o = 0, h = 1;
      function n(e) {
        for (var t = e.length;0 <= --t; )
          e[t] = 0;
      }
      var s = 0, a = 29, u = 256, l = u + 1 + a, f = 30, c = 19, _ = 2 * l + 1, g = 15, d = 16, p = 7, m = 256, b = 16, v = 17, y = 18, w = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0], k = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13], x = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7], S = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15], z = new Array(2 * (l + 2));
      n(z);
      var C = new Array(2 * f);
      n(C);
      var E = new Array(512);
      n(E);
      var A = new Array(256);
      n(A);
      var I = new Array(a);
      n(I);
      var O, B, R, T = new Array(f);
      function D(e, t, r, n, i) {
        this.static_tree = e, this.extra_bits = t, this.extra_base = r, this.elems = n, this.max_length = i, this.has_stree = e && e.length;
      }
      function F(e, t) {
        this.dyn_tree = e, this.max_code = 0, this.stat_desc = t;
      }
      function N(e) {
        return e < 256 ? E[e] : E[256 + (e >>> 7)];
      }
      function U(e, t) {
        e.pending_buf[e.pending++] = 255 & t, e.pending_buf[e.pending++] = t >>> 8 & 255;
      }
      function P(e, t, r) {
        e.bi_valid > d - r ? (e.bi_buf |= t << e.bi_valid & 65535, U(e, e.bi_buf), e.bi_buf = t >> d - e.bi_valid, e.bi_valid += r - d) : (e.bi_buf |= t << e.bi_valid & 65535, e.bi_valid += r);
      }
      function L(e, t, r) {
        P(e, r[2 * t], r[2 * t + 1]);
      }
      function j(e, t) {
        for (var r = 0;r |= 1 & e, e >>>= 1, r <<= 1, 0 < --t; )
          ;
        return r >>> 1;
      }
      function Z(e, t, r) {
        var n, i, s = new Array(g + 1), a = 0;
        for (n = 1;n <= g; n++)
          s[n] = a = a + r[n - 1] << 1;
        for (i = 0;i <= t; i++) {
          var o = e[2 * i + 1];
          o !== 0 && (e[2 * i] = j(s[o]++, o));
        }
      }
      function W(e) {
        var t;
        for (t = 0;t < l; t++)
          e.dyn_ltree[2 * t] = 0;
        for (t = 0;t < f; t++)
          e.dyn_dtree[2 * t] = 0;
        for (t = 0;t < c; t++)
          e.bl_tree[2 * t] = 0;
        e.dyn_ltree[2 * m] = 1, e.opt_len = e.static_len = 0, e.last_lit = e.matches = 0;
      }
      function M(e) {
        8 < e.bi_valid ? U(e, e.bi_buf) : 0 < e.bi_valid && (e.pending_buf[e.pending++] = e.bi_buf), e.bi_buf = 0, e.bi_valid = 0;
      }
      function H(e, t, r, n) {
        var i = 2 * t, s = 2 * r;
        return e[i] < e[s] || e[i] === e[s] && n[t] <= n[r];
      }
      function G(e, t, r) {
        for (var n = e.heap[r], i = r << 1;i <= e.heap_len && (i < e.heap_len && H(t, e.heap[i + 1], e.heap[i], e.depth) && i++, !H(t, n, e.heap[i], e.depth)); )
          e.heap[r] = e.heap[i], r = i, i <<= 1;
        e.heap[r] = n;
      }
      function K(e, t, r) {
        var n, i, s, a, o = 0;
        if (e.last_lit !== 0)
          for (;n = e.pending_buf[e.d_buf + 2 * o] << 8 | e.pending_buf[e.d_buf + 2 * o + 1], i = e.pending_buf[e.l_buf + o], o++, n === 0 ? L(e, i, t) : (L(e, (s = A[i]) + u + 1, t), (a = w[s]) !== 0 && P(e, i -= I[s], a), L(e, s = N(--n), r), (a = k[s]) !== 0 && P(e, n -= T[s], a)), o < e.last_lit; )
            ;
        L(e, m, t);
      }
      function Y(e, t) {
        var r, n, i, s = t.dyn_tree, a = t.stat_desc.static_tree, o = t.stat_desc.has_stree, h = t.stat_desc.elems, u = -1;
        for (e.heap_len = 0, e.heap_max = _, r = 0;r < h; r++)
          s[2 * r] !== 0 ? (e.heap[++e.heap_len] = u = r, e.depth[r] = 0) : s[2 * r + 1] = 0;
        for (;e.heap_len < 2; )
          s[2 * (i = e.heap[++e.heap_len] = u < 2 ? ++u : 0)] = 1, e.depth[i] = 0, e.opt_len--, o && (e.static_len -= a[2 * i + 1]);
        for (t.max_code = u, r = e.heap_len >> 1;1 <= r; r--)
          G(e, s, r);
        for (i = h;r = e.heap[1], e.heap[1] = e.heap[e.heap_len--], G(e, s, 1), n = e.heap[1], e.heap[--e.heap_max] = r, e.heap[--e.heap_max] = n, s[2 * i] = s[2 * r] + s[2 * n], e.depth[i] = (e.depth[r] >= e.depth[n] ? e.depth[r] : e.depth[n]) + 1, s[2 * r + 1] = s[2 * n + 1] = i, e.heap[1] = i++, G(e, s, 1), 2 <= e.heap_len; )
          ;
        e.heap[--e.heap_max] = e.heap[1], function(e, t) {
          var r, n, i, s, a, o, { dyn_tree: h, max_code: u } = t, l = t.stat_desc.static_tree, f = t.stat_desc.has_stree, c = t.stat_desc.extra_bits, d = t.stat_desc.extra_base, p = t.stat_desc.max_length, m = 0;
          for (s = 0;s <= g; s++)
            e.bl_count[s] = 0;
          for (h[2 * e.heap[e.heap_max] + 1] = 0, r = e.heap_max + 1;r < _; r++)
            p < (s = h[2 * h[2 * (n = e.heap[r]) + 1] + 1] + 1) && (s = p, m++), h[2 * n + 1] = s, u < n || (e.bl_count[s]++, a = 0, d <= n && (a = c[n - d]), o = h[2 * n], e.opt_len += o * (s + a), f && (e.static_len += o * (l[2 * n + 1] + a)));
          if (m !== 0) {
            do {
              for (s = p - 1;e.bl_count[s] === 0; )
                s--;
              e.bl_count[s]--, e.bl_count[s + 1] += 2, e.bl_count[p]--, m -= 2;
            } while (0 < m);
            for (s = p;s !== 0; s--)
              for (n = e.bl_count[s];n !== 0; )
                u < (i = e.heap[--r]) || (h[2 * i + 1] !== s && (e.opt_len += (s - h[2 * i + 1]) * h[2 * i], h[2 * i + 1] = s), n--);
          }
        }(e, t), Z(s, u, e.bl_count);
      }
      function X(e, t, r) {
        var n, i, s = -1, a = t[1], o = 0, h = 7, u = 4;
        for (a === 0 && (h = 138, u = 3), t[2 * (r + 1) + 1] = 65535, n = 0;n <= r; n++)
          i = a, a = t[2 * (n + 1) + 1], ++o < h && i === a || (o < u ? e.bl_tree[2 * i] += o : i !== 0 ? (i !== s && e.bl_tree[2 * i]++, e.bl_tree[2 * b]++) : o <= 10 ? e.bl_tree[2 * v]++ : e.bl_tree[2 * y]++, s = i, u = (o = 0) === a ? (h = 138, 3) : i === a ? (h = 6, 3) : (h = 7, 4));
      }
      function V(e, t, r) {
        var n, i, s = -1, a = t[1], o = 0, h = 7, u = 4;
        for (a === 0 && (h = 138, u = 3), n = 0;n <= r; n++)
          if (i = a, a = t[2 * (n + 1) + 1], !(++o < h && i === a)) {
            if (o < u)
              for (;L(e, i, e.bl_tree), --o != 0; )
                ;
            else
              i !== 0 ? (i !== s && (L(e, i, e.bl_tree), o--), L(e, b, e.bl_tree), P(e, o - 3, 2)) : o <= 10 ? (L(e, v, e.bl_tree), P(e, o - 3, 3)) : (L(e, y, e.bl_tree), P(e, o - 11, 7));
            s = i, u = (o = 0) === a ? (h = 138, 3) : i === a ? (h = 6, 3) : (h = 7, 4);
          }
      }
      n(T);
      var q = false;
      function J(e, t, r, n) {
        P(e, (s << 1) + (n ? 1 : 0), 3), function(e, t, r, n) {
          M(e), n && (U(e, r), U(e, ~r)), i.arraySet(e.pending_buf, e.window, t, r, e.pending), e.pending += r;
        }(e, t, r, true);
      }
      r._tr_init = function(e) {
        q || (function() {
          var e, t, r, n, i, s = new Array(g + 1);
          for (n = r = 0;n < a - 1; n++)
            for (I[n] = r, e = 0;e < 1 << w[n]; e++)
              A[r++] = n;
          for (A[r - 1] = n, n = i = 0;n < 16; n++)
            for (T[n] = i, e = 0;e < 1 << k[n]; e++)
              E[i++] = n;
          for (i >>= 7;n < f; n++)
            for (T[n] = i << 7, e = 0;e < 1 << k[n] - 7; e++)
              E[256 + i++] = n;
          for (t = 0;t <= g; t++)
            s[t] = 0;
          for (e = 0;e <= 143; )
            z[2 * e + 1] = 8, e++, s[8]++;
          for (;e <= 255; )
            z[2 * e + 1] = 9, e++, s[9]++;
          for (;e <= 279; )
            z[2 * e + 1] = 7, e++, s[7]++;
          for (;e <= 287; )
            z[2 * e + 1] = 8, e++, s[8]++;
          for (Z(z, l + 1, s), e = 0;e < f; e++)
            C[2 * e + 1] = 5, C[2 * e] = j(e, 5);
          O = new D(z, w, u + 1, l, g), B = new D(C, k, 0, f, g), R = new D(new Array(0), x, 0, c, p);
        }(), q = true), e.l_desc = new F(e.dyn_ltree, O), e.d_desc = new F(e.dyn_dtree, B), e.bl_desc = new F(e.bl_tree, R), e.bi_buf = 0, e.bi_valid = 0, W(e);
      }, r._tr_stored_block = J, r._tr_flush_block = function(e, t, r, n) {
        var i, s, a = 0;
        0 < e.level ? (e.strm.data_type === 2 && (e.strm.data_type = function(e) {
          var t, r = 4093624447;
          for (t = 0;t <= 31; t++, r >>>= 1)
            if (1 & r && e.dyn_ltree[2 * t] !== 0)
              return o;
          if (e.dyn_ltree[18] !== 0 || e.dyn_ltree[20] !== 0 || e.dyn_ltree[26] !== 0)
            return h;
          for (t = 32;t < u; t++)
            if (e.dyn_ltree[2 * t] !== 0)
              return h;
          return o;
        }(e)), Y(e, e.l_desc), Y(e, e.d_desc), a = function(e) {
          var t;
          for (X(e, e.dyn_ltree, e.l_desc.max_code), X(e, e.dyn_dtree, e.d_desc.max_code), Y(e, e.bl_desc), t = c - 1;3 <= t && e.bl_tree[2 * S[t] + 1] === 0; t--)
            ;
          return e.opt_len += 3 * (t + 1) + 5 + 5 + 4, t;
        }(e), i = e.opt_len + 3 + 7 >>> 3, (s = e.static_len + 3 + 7 >>> 3) <= i && (i = s)) : i = s = r + 5, r + 4 <= i && t !== -1 ? J(e, t, r, n) : e.strategy === 4 || s === i ? (P(e, 2 + (n ? 1 : 0), 3), K(e, z, C)) : (P(e, 4 + (n ? 1 : 0), 3), function(e, t, r, n) {
          var i;
          for (P(e, t - 257, 5), P(e, r - 1, 5), P(e, n - 4, 4), i = 0;i < n; i++)
            P(e, e.bl_tree[2 * S[i] + 1], 3);
          V(e, e.dyn_ltree, t - 1), V(e, e.dyn_dtree, r - 1);
        }(e, e.l_desc.max_code + 1, e.d_desc.max_code + 1, a + 1), K(e, e.dyn_ltree, e.dyn_dtree)), W(e), n && M(e);
      }, r._tr_tally = function(e, t, r) {
        return e.pending_buf[e.d_buf + 2 * e.last_lit] = t >>> 8 & 255, e.pending_buf[e.d_buf + 2 * e.last_lit + 1] = 255 & t, e.pending_buf[e.l_buf + e.last_lit] = 255 & r, e.last_lit++, t === 0 ? e.dyn_ltree[2 * r]++ : (e.matches++, t--, e.dyn_ltree[2 * (A[r] + u + 1)]++, e.dyn_dtree[2 * N(t)]++), e.last_lit === e.lit_bufsize - 1;
      }, r._tr_align = function(e) {
        P(e, 2, 3), L(e, m, z), function(e) {
          e.bi_valid === 16 ? (U(e, e.bi_buf), e.bi_buf = 0, e.bi_valid = 0) : 8 <= e.bi_valid && (e.pending_buf[e.pending++] = 255 & e.bi_buf, e.bi_buf >>= 8, e.bi_valid -= 8);
        }(e);
      };
    }, { "../utils/common": 41 }], 53: [function(e, t, r) {
      t.exports = function() {
        this.input = null, this.next_in = 0, this.avail_in = 0, this.total_in = 0, this.output = null, this.next_out = 0, this.avail_out = 0, this.total_out = 0, this.msg = "", this.state = null, this.data_type = 2, this.adler = 0;
      };
    }, {}], 54: [function(e, t, r) {
      (function(e) {
        (function(r, n) {
          if (!r.setImmediate) {
            var i, s, t, a, o = 1, h = {}, u = false, l = r.document, e = Object.getPrototypeOf && Object.getPrototypeOf(r);
            e = e && e.setTimeout ? e : r, i = {}.toString.call(r.process) === "[object process]" ? function(e) {
              process.nextTick(function() {
                c(e);
              });
            } : function() {
              if (r.postMessage && !r.importScripts) {
                var e = true, t = r.onmessage;
                return r.onmessage = function() {
                  e = false;
                }, r.postMessage("", "*"), r.onmessage = t, e;
              }
            }() ? (a = "setImmediate$" + Math.random() + "$", r.addEventListener ? r.addEventListener("message", d, false) : r.attachEvent("onmessage", d), function(e) {
              r.postMessage(a + e, "*");
            }) : r.MessageChannel ? ((t = new MessageChannel).port1.onmessage = function(e) {
              c(e.data);
            }, function(e) {
              t.port2.postMessage(e);
            }) : l && ("onreadystatechange" in l.createElement("script")) ? (s = l.documentElement, function(e) {
              var t = l.createElement("script");
              t.onreadystatechange = function() {
                c(e), t.onreadystatechange = null, s.removeChild(t), t = null;
              }, s.appendChild(t);
            }) : function(e) {
              setTimeout(c, 0, e);
            }, e.setImmediate = function(e) {
              typeof e != "function" && (e = new Function("" + e));
              for (var t = new Array(arguments.length - 1), r = 0;r < t.length; r++)
                t[r] = arguments[r + 1];
              var n = { callback: e, args: t };
              return h[o] = n, i(o), o++;
            }, e.clearImmediate = f;
          }
          function f(e) {
            delete h[e];
          }
          function c(e) {
            if (u)
              setTimeout(c, 0, e);
            else {
              var t = h[e];
              if (t) {
                u = true;
                try {
                  (function(e) {
                    var { callback: t, args: r } = e;
                    switch (r.length) {
                      case 0:
                        t();
                        break;
                      case 1:
                        t(r[0]);
                        break;
                      case 2:
                        t(r[0], r[1]);
                        break;
                      case 3:
                        t(r[0], r[1], r[2]);
                        break;
                      default:
                        t.apply(n, r);
                    }
                  })(t);
                } finally {
                  f(e), u = false;
                }
              }
            }
          }
          function d(e) {
            e.source === r && typeof e.data == "string" && e.data.indexOf(a) === 0 && c(+e.data.slice(a.length));
          }
        })(typeof self == "undefined" ? e === undefined ? this : e : self);
      }).call(this, typeof global != "undefined" ? global : typeof self != "undefined" ? self : typeof window != "undefined" ? window : {});
    }, {}] }, {}, [10])(10);
  });
});

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/pend/index.js
var require_pend = __commonJS(function(exports, module) {
  module.exports = Pend;
  function Pend() {
    this.pending = 0;
    this.max = Infinity;
    this.listeners = [];
    this.waiting = [];
    this.error = null;
  }
  Pend.prototype.go = function(fn) {
    if (this.pending < this.max) {
      pendGo(this, fn);
    } else {
      this.waiting.push(fn);
    }
  };
  Pend.prototype.wait = function(cb) {
    if (this.pending === 0) {
      cb(this.error);
    } else {
      this.listeners.push(cb);
    }
  };
  Pend.prototype.hold = function() {
    return pendHold(this);
  };
  function pendHold(self2) {
    self2.pending += 1;
    var called = false;
    return onCb;
    function onCb(err) {
      if (called)
        throw new Error("callback called twice");
      called = true;
      self2.error = self2.error || err;
      self2.pending -= 1;
      if (self2.waiting.length > 0 && self2.pending < self2.max) {
        pendGo(self2, self2.waiting.shift());
      } else if (self2.pending === 0) {
        var listeners = self2.listeners;
        self2.listeners = [];
        listeners.forEach(cbListener);
      }
    }
    function cbListener(listener) {
      listener(self2.error);
    }
  }
  function pendGo(self2, fn) {
    fn(pendHold(self2));
  }
});

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/yauzl/fd-slicer.js
var require_fd_slicer = __commonJS(function(exports) {
  var fs = __require("fs");
  var util = __require("util");
  var stream = __require("stream");
  var Readable = stream.Readable;
  var PassThrough = stream.PassThrough;
  var Pend = require_pend();
  var EventEmitter = __require("events").EventEmitter;
  exports.BufferSlicer = BufferSlicer;
  exports.FdSlicer = FdSlicer;
  util.inherits(FdSlicer, EventEmitter);
  function FdSlicer(fd) {
    EventEmitter.call(this);
    this.fd = fd;
    this.pend = new Pend;
    this.pend.max = 1;
    this.refCount = 0;
  }
  FdSlicer.prototype.read = function(buffer, offset, length, position, callback) {
    var self2 = this;
    self2.pend.go(function(cb) {
      fs.read(self2.fd, buffer, offset, length, position, function(err, bytesRead, buffer) {
        cb();
        callback(err, bytesRead, buffer);
      });
    });
  };
  FdSlicer.prototype.createReadStream = function(options2) {
    return new ReadStream(this, options2);
  };
  FdSlicer.prototype.ref = function() {
    this.refCount += 1;
  };
  FdSlicer.prototype.unref = function() {
    var self2 = this;
    self2.refCount -= 1;
    if (self2.refCount < 0)
      throw new Error("invalid unref");
    if (self2.refCount > 0)
      return;
    fs.close(self2.fd, onCloseDone);
    function onCloseDone(err) {
      if (err) {
        self2.emit("error", err);
      } else {
        self2.emit("close");
      }
    }
  };
  util.inherits(ReadStream, Readable);
  function ReadStream(context, options2) {
    options2 = options2 || {};
    Readable.call(this, options2);
    this.context = context;
    this.context.ref();
    this.start = options2.start || 0;
    this.endOffset = options2.end;
    this.pos = this.start;
  }
  ReadStream.prototype._read = function(n) {
    var self2 = this;
    var toRead = Math.min(self2._readableState.highWaterMark, n);
    if (self2.endOffset != null) {
      toRead = Math.min(toRead, self2.endOffset - self2.pos);
    }
    if (toRead <= 0) {
      self2.push(null);
      this._cleanup();
      return;
    }
    self2.context.pend.go(function(cb) {
      var buffer = Buffer.allocUnsafe(toRead);
      fs.read(self2.context.fd, buffer, 0, toRead, self2.pos, function(err, bytesRead) {
        if (err) {
          self2.destroy(err);
        } else if (bytesRead === 0) {
          self2.push(null);
          self2._cleanup();
        } else {
          self2.pos += bytesRead;
          self2.push(buffer.slice(0, bytesRead));
        }
        cb();
      });
    });
  };
  ReadStream.prototype._destroy = function(err, cb) {
    this._cleanup();
    cb(err);
  };
  ReadStream.prototype._cleanup = function() {
    if (this.context != null) {
      this.context.unref();
      this.context = null;
    }
  };
  util.inherits(BufferSlicer, EventEmitter);
  function BufferSlicer(buffer) {
    EventEmitter.call(this);
    this.refCount = 0;
    this.buffer = buffer;
  }
  BufferSlicer.prototype.read = function(buffer, offset, length, position, callback) {
    if (!(0 <= offset && offset <= buffer.length))
      throw new RangeError("offset outside buffer: 0 <= " + offset + " <= " + buffer.length);
    if (position < 0)
      throw new RangeError("position is negative: " + position);
    if (offset + length > buffer.length) {
      length = buffer.length - offset;
    }
    if (position + length > this.buffer.length) {
      length = this.buffer.length - position;
    }
    if (length <= 0) {
      setImmediate(function() {
        callback(null, 0);
      });
      return;
    }
    this.buffer.copy(buffer, offset, position, position + length);
    setImmediate(function() {
      callback(null, length);
    });
  };
  BufferSlicer.prototype.createReadStream = function(options2) {
    options2 = options2 || {};
    var readStream = new PassThrough(options2);
    readStream.start = options2.start || 0;
    readStream.endOffset = options2.end;
    readStream.pos = readStream.endOffset || this.buffer.length;
    var entireSlice = this.buffer.slice(readStream.start, readStream.pos);
    var maxChunkSize = 65536;
    var offset = 0;
    while (true) {
      var nextOffset = offset + maxChunkSize;
      if (nextOffset >= entireSlice.length) {
        if (offset < entireSlice.length) {
          readStream.write(entireSlice.slice(offset, entireSlice.length));
        }
        break;
      }
      readStream.write(entireSlice.slice(offset, nextOffset));
      offset = nextOffset;
    }
    readStream.end();
    return readStream;
  };
  BufferSlicer.prototype.ref = function() {
    this.refCount += 1;
  };
  BufferSlicer.prototype.unref = function() {
    this.refCount -= 1;
    if (this.refCount < 0) {
      throw new Error("invalid unref");
    }
  };
});

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/yauzl/crc32.js
var require_crc32 = __commonJS(function(exports, module) {
  var CRC_TABLE = new Int32Array([
    0,
    1996959894,
    3993919788,
    2567524794,
    124634137,
    1886057615,
    3915621685,
    2657392035,
    249268274,
    2044508324,
    3772115230,
    2547177864,
    162941995,
    2125561021,
    3887607047,
    2428444049,
    498536548,
    1789927666,
    4089016648,
    2227061214,
    450548861,
    1843258603,
    4107580753,
    2211677639,
    325883990,
    1684777152,
    4251122042,
    2321926636,
    335633487,
    1661365465,
    4195302755,
    2366115317,
    997073096,
    1281953886,
    3579855332,
    2724688242,
    1006888145,
    1258607687,
    3524101629,
    2768942443,
    901097722,
    1119000684,
    3686517206,
    2898065728,
    853044451,
    1172266101,
    3705015759,
    2882616665,
    651767980,
    1373503546,
    3369554304,
    3218104598,
    565507253,
    1454621731,
    3485111705,
    3099436303,
    671266974,
    1594198024,
    3322730930,
    2970347812,
    795835527,
    1483230225,
    3244367275,
    3060149565,
    1994146192,
    31158534,
    2563907772,
    4023717930,
    1907459465,
    112637215,
    2680153253,
    3904427059,
    2013776290,
    251722036,
    2517215374,
    3775830040,
    2137656763,
    141376813,
    2439277719,
    3865271297,
    1802195444,
    476864866,
    2238001368,
    4066508878,
    1812370925,
    453092731,
    2181625025,
    4111451223,
    1706088902,
    314042704,
    2344532202,
    4240017532,
    1658658271,
    366619977,
    2362670323,
    4224994405,
    1303535960,
    984961486,
    2747007092,
    3569037538,
    1256170817,
    1037604311,
    2765210733,
    3554079995,
    1131014506,
    879679996,
    2909243462,
    3663771856,
    1141124467,
    855842277,
    2852801631,
    3708648649,
    1342533948,
    654459306,
    3188396048,
    3373015174,
    1466479909,
    544179635,
    3110523913,
    3462522015,
    1591671054,
    702138776,
    2966460450,
    3352799412,
    1504918807,
    783551873,
    3082640443,
    3233442989,
    3988292384,
    2596254646,
    62317068,
    1957810842,
    3939845945,
    2647816111,
    81470997,
    1943803523,
    3814918930,
    2489596804,
    225274430,
    2053790376,
    3826175755,
    2466906013,
    167816743,
    2097651377,
    4027552580,
    2265490386,
    503444072,
    1762050814,
    4150417245,
    2154129355,
    426522225,
    1852507879,
    4275313526,
    2312317920,
    282753626,
    1742555852,
    4189708143,
    2394877945,
    397917763,
    1622183637,
    3604390888,
    2714866558,
    953729732,
    1340076626,
    3518719985,
    2797360999,
    1068828381,
    1219638859,
    3624741850,
    2936675148,
    906185462,
    1090812512,
    3747672003,
    2825379669,
    829329135,
    1181335161,
    3412177804,
    3160834842,
    628085408,
    1382605366,
    3423369109,
    3138078467,
    570562233,
    1426400815,
    3317316542,
    2998733608,
    733239954,
    1555261956,
    3268935591,
    3050360625,
    752459403,
    1541320221,
    2607071920,
    3965973030,
    1969922972,
    40735498,
    2617837225,
    3943577151,
    1913087877,
    83908371,
    2512341634,
    3803740692,
    2075208622,
    213261112,
    2463272603,
    3855990285,
    2094854071,
    198958881,
    2262029012,
    4057260610,
    1759359992,
    534414190,
    2176718541,
    4139329115,
    1873836001,
    414664567,
    2282248934,
    4279200368,
    1711684554,
    285281116,
    2405801727,
    4167216745,
    1634467795,
    376229701,
    2685067896,
    3608007406,
    1308918612,
    956543938,
    2808555105,
    3495958263,
    1231636301,
    1047427035,
    2932959818,
    3654703836,
    1088359270,
    936918000,
    2847714899,
    3736837829,
    1202900863,
    817233897,
    3183342108,
    3401237130,
    1404277552,
    615818150,
    3134207493,
    3453421203,
    1423857449,
    601450431,
    3009837614,
    3294710456,
    1567103746,
    711928724,
    3020668471,
    3272380065,
    1510334235,
    755167117
  ]);
  function crc32(buf) {
    let crc = -1;
    for (let x of buf) {
      crc = CRC_TABLE[(crc ^ x) & 255] ^ crc >>> 8;
    }
    return (crc ^ -1) >>> 0;
  }
  module.exports = crc32;
});

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/@xmldom/xmldom/lib/conventions.js
var require_conventions = __commonJS(function(exports) {
  function find(list, predicate, ac) {
    if (ac === undefined) {
      ac = Array.prototype;
    }
    if (list && typeof ac.find === "function") {
      return ac.find.call(list, predicate);
    }
    for (var i = 0;i < list.length; i++) {
      if (hasOwn(list, i)) {
        var item = list[i];
        if (predicate.call(undefined, item, i, list)) {
          return item;
        }
      }
    }
  }
  function freeze(object, oc) {
    if (oc === undefined) {
      oc = Object;
    }
    if (oc && typeof oc.getOwnPropertyDescriptors === "function") {
      object = oc.create(null, oc.getOwnPropertyDescriptors(object));
    }
    return oc && typeof oc.freeze === "function" ? oc.freeze(object) : object;
  }
  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }
  function assign(target, source) {
    if (target === null || typeof target !== "object") {
      throw new TypeError("target is not an object");
    }
    for (var key in source) {
      if (hasOwn(source, key)) {
        target[key] = source[key];
      }
    }
    return target;
  }
  var HTML_BOOLEAN_ATTRIBUTES = freeze({
    allowfullscreen: true,
    async: true,
    autofocus: true,
    autoplay: true,
    checked: true,
    controls: true,
    default: true,
    defer: true,
    disabled: true,
    formnovalidate: true,
    hidden: true,
    ismap: true,
    itemscope: true,
    loop: true,
    multiple: true,
    muted: true,
    nomodule: true,
    novalidate: true,
    open: true,
    playsinline: true,
    readonly: true,
    required: true,
    reversed: true,
    selected: true
  });
  function isHTMLBooleanAttribute(name) {
    return hasOwn(HTML_BOOLEAN_ATTRIBUTES, name.toLowerCase());
  }
  var HTML_VOID_ELEMENTS = freeze({
    area: true,
    base: true,
    br: true,
    col: true,
    embed: true,
    hr: true,
    img: true,
    input: true,
    link: true,
    meta: true,
    param: true,
    source: true,
    track: true,
    wbr: true
  });
  function isHTMLVoidElement(tagName) {
    return hasOwn(HTML_VOID_ELEMENTS, tagName.toLowerCase());
  }
  var HTML_RAW_TEXT_ELEMENTS = freeze({
    script: false,
    style: false,
    textarea: true,
    title: true
  });
  function isHTMLRawTextElement(tagName) {
    var key = tagName.toLowerCase();
    return hasOwn(HTML_RAW_TEXT_ELEMENTS, key) && !HTML_RAW_TEXT_ELEMENTS[key];
  }
  function isHTMLEscapableRawTextElement(tagName) {
    var key = tagName.toLowerCase();
    return hasOwn(HTML_RAW_TEXT_ELEMENTS, key) && HTML_RAW_TEXT_ELEMENTS[key];
  }
  function isHTMLMimeType(mimeType) {
    return mimeType === MIME_TYPE.HTML;
  }
  function hasDefaultHTMLNamespace(mimeType) {
    return isHTMLMimeType(mimeType) || mimeType === MIME_TYPE.XML_XHTML_APPLICATION;
  }
  var MIME_TYPE = freeze({
    HTML: "text/html",
    XML_APPLICATION: "application/xml",
    XML_TEXT: "text/xml",
    XML_XHTML_APPLICATION: "application/xhtml+xml",
    XML_SVG_IMAGE: "image/svg+xml"
  });
  var _MIME_TYPES = Object.keys(MIME_TYPE).map(function(key) {
    return MIME_TYPE[key];
  });
  function isValidMimeType(mimeType) {
    return _MIME_TYPES.indexOf(mimeType) > -1;
  }
  var NAMESPACE = freeze({
    HTML: "http://www.w3.org/1999/xhtml",
    SVG: "http://www.w3.org/2000/svg",
    XML: "http://www.w3.org/XML/1998/namespace",
    XMLNS: "http://www.w3.org/2000/xmlns/"
  });
  exports.assign = assign;
  exports.find = find;
  exports.freeze = freeze;
  exports.HTML_BOOLEAN_ATTRIBUTES = HTML_BOOLEAN_ATTRIBUTES;
  exports.HTML_RAW_TEXT_ELEMENTS = HTML_RAW_TEXT_ELEMENTS;
  exports.HTML_VOID_ELEMENTS = HTML_VOID_ELEMENTS;
  exports.hasDefaultHTMLNamespace = hasDefaultHTMLNamespace;
  exports.hasOwn = hasOwn;
  exports.isHTMLBooleanAttribute = isHTMLBooleanAttribute;
  exports.isHTMLRawTextElement = isHTMLRawTextElement;
  exports.isHTMLEscapableRawTextElement = isHTMLEscapableRawTextElement;
  exports.isHTMLMimeType = isHTMLMimeType;
  exports.isHTMLVoidElement = isHTMLVoidElement;
  exports.isValidMimeType = isValidMimeType;
  exports.MIME_TYPE = MIME_TYPE;
  exports.NAMESPACE = NAMESPACE;
});

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/@xmldom/xmldom/lib/errors.js
var require_errors = __commonJS(function(exports) {
  var conventions = require_conventions();
  function extendError(constructor, writableName) {
    constructor.prototype = Object.create(Error.prototype, {
      constructor: { value: constructor },
      name: { value: constructor.name, enumerable: true, writable: writableName }
    });
  }
  var DOMExceptionName = conventions.freeze({
    Error: "Error",
    IndexSizeError: "IndexSizeError",
    DomstringSizeError: "DomstringSizeError",
    HierarchyRequestError: "HierarchyRequestError",
    WrongDocumentError: "WrongDocumentError",
    InvalidCharacterError: "InvalidCharacterError",
    NoDataAllowedError: "NoDataAllowedError",
    NoModificationAllowedError: "NoModificationAllowedError",
    NotFoundError: "NotFoundError",
    NotSupportedError: "NotSupportedError",
    InUseAttributeError: "InUseAttributeError",
    InvalidStateError: "InvalidStateError",
    SyntaxError: "SyntaxError",
    InvalidModificationError: "InvalidModificationError",
    NamespaceError: "NamespaceError",
    InvalidAccessError: "InvalidAccessError",
    ValidationError: "ValidationError",
    TypeMismatchError: "TypeMismatchError",
    SecurityError: "SecurityError",
    NetworkError: "NetworkError",
    AbortError: "AbortError",
    URLMismatchError: "URLMismatchError",
    QuotaExceededError: "QuotaExceededError",
    TimeoutError: "TimeoutError",
    InvalidNodeTypeError: "InvalidNodeTypeError",
    DataCloneError: "DataCloneError",
    EncodingError: "EncodingError",
    NotReadableError: "NotReadableError",
    UnknownError: "UnknownError",
    ConstraintError: "ConstraintError",
    DataError: "DataError",
    TransactionInactiveError: "TransactionInactiveError",
    ReadOnlyError: "ReadOnlyError",
    VersionError: "VersionError",
    OperationError: "OperationError",
    NotAllowedError: "NotAllowedError",
    OptOutError: "OptOutError"
  });
  var DOMExceptionNames = Object.keys(DOMExceptionName);
  function isValidDomExceptionCode(value) {
    return typeof value === "number" && value >= 1 && value <= 25;
  }
  function endsWithError(value) {
    return typeof value === "string" && value.substring(value.length - DOMExceptionName.Error.length) === DOMExceptionName.Error;
  }
  function DOMException(messageOrCode, nameOrMessage) {
    if (isValidDomExceptionCode(messageOrCode)) {
      this.name = DOMExceptionNames[messageOrCode];
      this.message = nameOrMessage || "";
    } else {
      this.message = messageOrCode;
      this.name = endsWithError(nameOrMessage) ? nameOrMessage : DOMExceptionName.Error;
    }
    if (Error.captureStackTrace)
      Error.captureStackTrace(this, DOMException);
  }
  extendError(DOMException, true);
  Object.defineProperties(DOMException.prototype, {
    code: {
      enumerable: true,
      get: function() {
        var code = DOMExceptionNames.indexOf(this.name);
        if (isValidDomExceptionCode(code))
          return code;
        return 0;
      }
    }
  });
  var ExceptionCode = {
    INDEX_SIZE_ERR: 1,
    DOMSTRING_SIZE_ERR: 2,
    HIERARCHY_REQUEST_ERR: 3,
    WRONG_DOCUMENT_ERR: 4,
    INVALID_CHARACTER_ERR: 5,
    NO_DATA_ALLOWED_ERR: 6,
    NO_MODIFICATION_ALLOWED_ERR: 7,
    NOT_FOUND_ERR: 8,
    NOT_SUPPORTED_ERR: 9,
    INUSE_ATTRIBUTE_ERR: 10,
    INVALID_STATE_ERR: 11,
    SYNTAX_ERR: 12,
    INVALID_MODIFICATION_ERR: 13,
    NAMESPACE_ERR: 14,
    INVALID_ACCESS_ERR: 15,
    VALIDATION_ERR: 16,
    TYPE_MISMATCH_ERR: 17,
    SECURITY_ERR: 18,
    NETWORK_ERR: 19,
    ABORT_ERR: 20,
    URL_MISMATCH_ERR: 21,
    QUOTA_EXCEEDED_ERR: 22,
    TIMEOUT_ERR: 23,
    INVALID_NODE_TYPE_ERR: 24,
    DATA_CLONE_ERR: 25
  };
  var entries = Object.entries(ExceptionCode);
  for (i = 0;i < entries.length; i++) {
    key = entries[i][0];
    DOMException[key] = entries[i][1];
  }
  var key;
  var i;
  function ParseError(message, locator, cause) {
    this.message = message;
    this.locator = locator;
    this.cause = cause;
    if (Error.captureStackTrace)
      Error.captureStackTrace(this, ParseError);
  }
  extendError(ParseError);
  exports.DOMException = DOMException;
  exports.DOMExceptionName = DOMExceptionName;
  exports.ExceptionCode = ExceptionCode;
  exports.ParseError = ParseError;
});

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/@xmldom/xmldom/lib/grammar.js
var require_grammar = __commonJS(function(exports) {
  function detectUnicodeSupport(RegExpImpl) {
    try {
      if (typeof RegExpImpl !== "function") {
        RegExpImpl = RegExp;
      }
      var match = new RegExpImpl("\uD834\uDF06", "u").exec("\uD834\uDF06");
      return !!match && match[0].length === 2;
    } catch (error) {}
    return false;
  }
  var UNICODE_SUPPORT = detectUnicodeSupport();
  function chars(regexp) {
    if (regexp.source[0] !== "[") {
      throw new Error(regexp + " can not be used with chars");
    }
    return regexp.source.slice(1, regexp.source.lastIndexOf("]"));
  }
  function chars_without(regexp, search) {
    if (regexp.source[0] !== "[") {
      throw new Error("/" + regexp.source + "/ can not be used with chars_without");
    }
    if (!search || typeof search !== "string") {
      throw new Error(JSON.stringify(search) + " is not a valid search");
    }
    if (regexp.source.indexOf(search) === -1) {
      throw new Error('"' + search + '" is not is /' + regexp.source + "/");
    }
    if (search === "-" && regexp.source.indexOf(search) !== 1) {
      throw new Error('"' + search + '" is not at the first postion of /' + regexp.source + "/");
    }
    return new RegExp(regexp.source.replace(search, ""), UNICODE_SUPPORT ? "u" : "");
  }
  function reg(args) {
    var self2 = this;
    return new RegExp(Array.prototype.slice.call(arguments).map(function(part) {
      var isStr = typeof part === "string";
      if (isStr && self2 === undefined && part === "|") {
        throw new Error("use regg instead of reg to wrap expressions with `|`!");
      }
      return isStr ? part : part.source;
    }).join(""), UNICODE_SUPPORT ? "u" : "");
  }
  function regg(args) {
    if (arguments.length === 0) {
      throw new Error("no parameters provided");
    }
    return reg.apply(regg, ["(?:"].concat(Array.prototype.slice.call(arguments), [")"]));
  }
  var UNICODE_REPLACEMENT_CHARACTER = "�";
  var Char = /[-\x09\x0A\x0D\x20-\x2C\x2E-\uD7FF\uE000-\uFFFD]/;
  if (UNICODE_SUPPORT) {
    Char = reg("[", chars(Char), "\\u{10000}-\\u{10FFFF}", "]");
  }
  var InvalidChar = new RegExp("[^" + chars(Char) + "]", UNICODE_SUPPORT ? "u" : "");
  var _SChar = /[\x20\x09\x0D\x0A]/;
  var SChar_s = chars(_SChar);
  var S = reg(_SChar, "+");
  var S_OPT = reg(_SChar, "*");
  var NameStartChar = /[:_a-zA-Z\xC0-\xD6\xD8-\xF6\xF8-\u02FF\u0370-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]/;
  if (UNICODE_SUPPORT) {
    NameStartChar = reg("[", chars(NameStartChar), "\\u{10000}-\\u{10FFFF}", "]");
  }
  var NameStartChar_s = chars(NameStartChar);
  var NameChar = reg("[", NameStartChar_s, chars(/[-.0-9\xB7]/), chars(/[\u0300-\u036F\u203F-\u2040]/), "]");
  var Name = reg(NameStartChar, NameChar, "*");
  var Name_exact = reg("^", Name, "$");
  var Nmtoken = reg(NameChar, "+");
  var EntityRef = reg("&", Name, ";");
  var CharRef = regg(/&#[0-9]+;|&#x[0-9a-fA-F]+;/);
  var Reference = regg(EntityRef, "|", CharRef);
  var PEReference = reg("%", Name, ";");
  var EntityValue = regg(reg('"', regg(/[^%&"]/, "|", PEReference, "|", Reference), "*", '"'), "|", reg("'", regg(/[^%&']/, "|", PEReference, "|", Reference), "*", "'"));
  var AttValue = regg('"', regg(/[^<&"]/, "|", Reference), "*", '"', "|", "'", regg(/[^<&']/, "|", Reference), "*", "'");
  var NCNameStartChar = chars_without(NameStartChar, ":");
  var NCNameChar = chars_without(NameChar, ":");
  var NCName = reg(NCNameStartChar, NCNameChar, "*");
  var NCName_exact = reg("^", NCName, "$");
  var QName = reg(NCName, regg(":", NCName), "?");
  var QName_exact = reg("^", QName, "$");
  var QName_group = reg("(", QName, ")");
  var SystemLiteral = regg(/"[^"]*"|'[^']*'/);
  var PI = reg(/^<\?/, "(", Name, ")", regg(S, "(?!", _SChar, ")(", Char, "*?)"), "?", /\?>/);
  var PubidChar = /[\x20\x0D\x0Aa-zA-Z0-9-'()+,./:=?;!*#@$_%]/;
  var PubidLiteral = regg('"', PubidChar, '*"', "|", "'", chars_without(PubidChar, "'"), "*'");
  var COMMENT_START = "<!--";
  var COMMENT_END = "-->";
  var Comment = reg(COMMENT_START, regg(chars_without(Char, "-"), "|", reg("-", chars_without(Char, "-"))), "*", COMMENT_END);
  var PCDATA = "#PCDATA";
  var Mixed = regg(reg(/\(/, S_OPT, PCDATA, regg(S_OPT, /\|/, S_OPT, QName), "*", S_OPT, /\)\*/), "|", reg(/\(/, S_OPT, PCDATA, S_OPT, /\)/));
  var _children_quantity = /[?*+]?/;
  var children = reg(/\([^>]+\)/, _children_quantity);
  var contentspec = regg("EMPTY", "|", "ANY", "|", Mixed, "|", children);
  var ELEMENTDECL_START = "<!ELEMENT";
  var elementdecl = reg(ELEMENTDECL_START, S, regg(QName, "|", PEReference), S, regg(contentspec, "|", PEReference), S_OPT, ">");
  var NotationType = reg("NOTATION", S, /\(/, S_OPT, Name, regg(S_OPT, /\|/, S_OPT, Name), "*", S_OPT, /\)/);
  var Enumeration = reg(/\(/, S_OPT, Nmtoken, regg(S_OPT, /\|/, S_OPT, Nmtoken), "*", S_OPT, /\)/);
  var EnumeratedType = regg(NotationType, "|", Enumeration);
  var AttType = regg(/CDATA|ID|IDREF|IDREFS|ENTITY|ENTITIES|NMTOKEN|NMTOKENS/, "|", EnumeratedType);
  var DefaultDecl = regg(/#REQUIRED|#IMPLIED/, "|", regg(regg("#FIXED", S), "?", AttValue));
  var AttDef = regg(S, Name, S, AttType, S, DefaultDecl);
  var ATTLIST_DECL_START = "<!ATTLIST";
  var AttlistDecl = reg(ATTLIST_DECL_START, S, Name, AttDef, "*", S_OPT, ">");
  var ABOUT_LEGACY_COMPAT = "about:legacy-compat";
  var ABOUT_LEGACY_COMPAT_SystemLiteral = regg('"' + ABOUT_LEGACY_COMPAT + '"', "|", "'" + ABOUT_LEGACY_COMPAT + "'");
  var SYSTEM = "SYSTEM";
  var PUBLIC = "PUBLIC";
  var ExternalID = regg(regg(SYSTEM, S, SystemLiteral), "|", regg(PUBLIC, S, PubidLiteral, S, SystemLiteral));
  var ExternalID_match = reg("^", regg(regg(SYSTEM, S, "(?<SystemLiteralOnly>", SystemLiteral, ")"), "|", regg(PUBLIC, S, "(?<PubidLiteral>", PubidLiteral, ")", S, "(?<SystemLiteral>", SystemLiteral, ")")));
  var PubidLiteral_match = reg("^", PubidLiteral, "$");
  var SystemLiteral_match = reg("^", SystemLiteral, "$");
  var NDataDecl = regg(S, "NDATA", S, Name);
  var EntityDef = regg(EntityValue, "|", regg(ExternalID, NDataDecl, "?"));
  var ENTITY_DECL_START = "<!ENTITY";
  var GEDecl = reg(ENTITY_DECL_START, S, Name, S, EntityDef, S_OPT, ">");
  var PEDef = regg(EntityValue, "|", ExternalID);
  var PEDecl = reg(ENTITY_DECL_START, S, "%", S, Name, S, PEDef, S_OPT, ">");
  var EntityDecl = regg(GEDecl, "|", PEDecl);
  var PublicID = reg(PUBLIC, S, PubidLiteral);
  var NotationDecl = reg("<!NOTATION", S, Name, S, regg(ExternalID, "|", PublicID), S_OPT, ">");
  var Eq = reg(S_OPT, "=", S_OPT);
  var VersionNum = /1[.]\d+/;
  var VersionInfo = reg(S, "version", Eq, regg("'", VersionNum, "'", "|", '"', VersionNum, '"'));
  var EncName = /[A-Za-z][-A-Za-z0-9._]*/;
  var EncodingDecl = regg(S, "encoding", Eq, regg('"', EncName, '"', "|", "'", EncName, "'"));
  var SDDecl = regg(S, "standalone", Eq, regg("'", regg("yes", "|", "no"), "'", "|", '"', regg("yes", "|", "no"), '"'));
  var XMLDecl = reg(/^<\?xml/, VersionInfo, EncodingDecl, "?", SDDecl, "?", S_OPT, /\?>/);
  var DOCTYPE_DECL_START = "<!DOCTYPE";
  var CDATA_START = "<![CDATA[";
  var CDATA_END = "]]>";
  var CDStart = /<!\[CDATA\[/;
  var CDEnd = /\]\]>/;
  var CData = reg(Char, "*?", CDEnd);
  var CDSect = reg(CDStart, CData);
  exports.chars = chars;
  exports.chars_without = chars_without;
  exports.detectUnicodeSupport = detectUnicodeSupport;
  exports.reg = reg;
  exports.regg = regg;
  exports.ABOUT_LEGACY_COMPAT = ABOUT_LEGACY_COMPAT;
  exports.ABOUT_LEGACY_COMPAT_SystemLiteral = ABOUT_LEGACY_COMPAT_SystemLiteral;
  exports.AttlistDecl = AttlistDecl;
  exports.CDATA_START = CDATA_START;
  exports.CDATA_END = CDATA_END;
  exports.CDSect = CDSect;
  exports.Char = Char;
  exports.Comment = Comment;
  exports.COMMENT_START = COMMENT_START;
  exports.COMMENT_END = COMMENT_END;
  exports.DOCTYPE_DECL_START = DOCTYPE_DECL_START;
  exports.elementdecl = elementdecl;
  exports.EntityDecl = EntityDecl;
  exports.EntityValue = EntityValue;
  exports.ExternalID = ExternalID;
  exports.ExternalID_match = ExternalID_match;
  exports.Name = Name;
  exports.Name_exact = Name_exact;
  exports.NCName_exact = NCName_exact;
  exports.NotationDecl = NotationDecl;
  exports.Reference = Reference;
  exports.PEReference = PEReference;
  exports.PI = PI;
  exports.PUBLIC = PUBLIC;
  exports.PubidLiteral = PubidLiteral;
  exports.PubidLiteral_match = PubidLiteral_match;
  exports.QName = QName;
  exports.QName_exact = QName_exact;
  exports.QName_group = QName_group;
  exports.S = S;
  exports.SChar_s = SChar_s;
  exports.S_OPT = S_OPT;
  exports.SYSTEM = SYSTEM;
  exports.SystemLiteral = SystemLiteral;
  exports.SystemLiteral_match = SystemLiteral_match;
  exports.InvalidChar = InvalidChar;
  exports.UNICODE_REPLACEMENT_CHARACTER = UNICODE_REPLACEMENT_CHARACTER;
  exports.UNICODE_SUPPORT = UNICODE_SUPPORT;
  exports.XMLDecl = XMLDecl;
});

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/@xmldom/xmldom/lib/dom.js
var require_dom = __commonJS(function(exports) {
  var conventions = require_conventions();
  var find = conventions.find;
  var hasDefaultHTMLNamespace = conventions.hasDefaultHTMLNamespace;
  var hasOwn = conventions.hasOwn;
  var isHTMLMimeType = conventions.isHTMLMimeType;
  var isHTMLRawTextElement = conventions.isHTMLRawTextElement;
  var isHTMLVoidElement = conventions.isHTMLVoidElement;
  var MIME_TYPE = conventions.MIME_TYPE;
  var NAMESPACE = conventions.NAMESPACE;
  var PDC = Symbol();
  var errors = require_errors();
  var DOMException = errors.DOMException;
  var DOMExceptionName = errors.DOMExceptionName;
  var g = require_grammar();
  function checkSymbol(symbol) {
    if (symbol !== PDC) {
      throw new TypeError("Illegal constructor");
    }
  }
  function notEmptyString(input) {
    return input !== "";
  }
  function splitOnASCIIWhitespace(input) {
    return input ? input.split(/[\t\n\f\r ]+/).filter(notEmptyString) : [];
  }
  function orderedSetReducer(current, element) {
    if (!hasOwn(current, element)) {
      current[element] = true;
    }
    return current;
  }
  function toOrderedSet(input) {
    if (!input)
      return [];
    var list = splitOnASCIIWhitespace(input);
    return Object.keys(list.reduce(orderedSetReducer, {}));
  }
  function arrayIncludes(list) {
    return function(element) {
      return list && list.indexOf(element) !== -1;
    };
  }
  function validateQualifiedName(qualifiedName) {
    if (!g.QName_exact.test(qualifiedName)) {
      throw new DOMException(DOMException.INVALID_CHARACTER_ERR, 'invalid character in qualified name "' + qualifiedName + '"');
    }
  }
  function validateAndExtract(namespace, qualifiedName) {
    validateQualifiedName(qualifiedName);
    namespace = namespace || null;
    var prefix = null;
    var localName = qualifiedName;
    if (qualifiedName.indexOf(":") >= 0) {
      var splitResult = qualifiedName.split(":");
      prefix = splitResult[0];
      localName = splitResult[1];
    }
    if (prefix !== null && namespace === null) {
      throw new DOMException(DOMException.NAMESPACE_ERR, "prefix is non-null and namespace is null");
    }
    if (prefix === "xml" && namespace !== conventions.NAMESPACE.XML) {
      throw new DOMException(DOMException.NAMESPACE_ERR, 'prefix is "xml" and namespace is not the XML namespace');
    }
    if ((prefix === "xmlns" || qualifiedName === "xmlns") && namespace !== conventions.NAMESPACE.XMLNS) {
      throw new DOMException(DOMException.NAMESPACE_ERR, 'either qualifiedName or prefix is "xmlns" and namespace is not the XMLNS namespace');
    }
    if (namespace === conventions.NAMESPACE.XMLNS && prefix !== "xmlns" && qualifiedName !== "xmlns") {
      throw new DOMException(DOMException.NAMESPACE_ERR, 'namespace is the XMLNS namespace and neither qualifiedName nor prefix is "xmlns"');
    }
    return [namespace, prefix, localName];
  }
  function copy(src, dest) {
    for (var p in src) {
      if (hasOwn(src, p)) {
        dest[p] = src[p];
      }
    }
  }
  function _extends(Class, Super) {
    var pt = Class.prototype;
    if (!(pt instanceof Super)) {
      let t = function() {};
      t.prototype = Super.prototype;
      t = new t;
      copy(pt, t);
      Class.prototype = pt = t;
    }
    if (pt.constructor != Class) {
      if (typeof Class != "function") {
        console.error("unknown Class:" + Class);
      }
      pt.constructor = Class;
    }
  }
  var NodeType = {};
  var ELEMENT_NODE = NodeType.ELEMENT_NODE = 1;
  var ATTRIBUTE_NODE = NodeType.ATTRIBUTE_NODE = 2;
  var TEXT_NODE = NodeType.TEXT_NODE = 3;
  var CDATA_SECTION_NODE = NodeType.CDATA_SECTION_NODE = 4;
  var ENTITY_REFERENCE_NODE = NodeType.ENTITY_REFERENCE_NODE = 5;
  var ENTITY_NODE = NodeType.ENTITY_NODE = 6;
  var PROCESSING_INSTRUCTION_NODE = NodeType.PROCESSING_INSTRUCTION_NODE = 7;
  var COMMENT_NODE = NodeType.COMMENT_NODE = 8;
  var DOCUMENT_NODE = NodeType.DOCUMENT_NODE = 9;
  var DOCUMENT_TYPE_NODE = NodeType.DOCUMENT_TYPE_NODE = 10;
  var DOCUMENT_FRAGMENT_NODE = NodeType.DOCUMENT_FRAGMENT_NODE = 11;
  var NOTATION_NODE = NodeType.NOTATION_NODE = 12;
  var DocumentPosition = conventions.freeze({
    DOCUMENT_POSITION_DISCONNECTED: 1,
    DOCUMENT_POSITION_PRECEDING: 2,
    DOCUMENT_POSITION_FOLLOWING: 4,
    DOCUMENT_POSITION_CONTAINS: 8,
    DOCUMENT_POSITION_CONTAINED_BY: 16,
    DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 32
  });
  function commonAncestor(a, b) {
    if (b.length < a.length)
      return commonAncestor(b, a);
    var c = null;
    for (var n in a) {
      if (a[n] !== b[n])
        return c;
      c = a[n];
    }
    return c;
  }
  function docGUID(doc) {
    if (!doc.guid)
      doc.guid = Math.random();
    return doc.guid;
  }
  function NodeList() {}
  NodeList.prototype = {
    length: 0,
    item: function(index) {
      return index >= 0 && index < this.length ? this[index] : null;
    },
    toString: function(options2) {
      var opts;
      if (typeof options2 === "function") {
        opts = { requireWellFormed: false, splitCDATASections: true, nodeFilter: options2 };
      } else if (!!options2) {
        opts = {
          requireWellFormed: !!options2.requireWellFormed,
          splitCDATASections: options2.splitCDATASections !== false,
          nodeFilter: options2.nodeFilter || null
        };
      } else {
        opts = { requireWellFormed: false, splitCDATASections: true, nodeFilter: null };
      }
      for (var buf = [], i = 0;i < this.length; i++) {
        serializeToString(this[i], buf, null, opts);
      }
      return buf.join("");
    },
    filter: function(predicate) {
      return Array.prototype.filter.call(this, predicate);
    },
    indexOf: function(item) {
      return Array.prototype.indexOf.call(this, item);
    }
  };
  NodeList.prototype[Symbol.iterator] = function() {
    var me = this;
    var index = 0;
    return {
      next: function() {
        if (index < me.length) {
          return {
            value: me[index++],
            done: false
          };
        } else {
          return {
            done: true
          };
        }
      },
      return: function() {
        return {
          done: true
        };
      }
    };
  };
  function LiveNodeList(node, refresh) {
    this._node = node;
    this._refresh = refresh;
    _updateLiveList(this);
  }
  function _updateLiveList(list) {
    var inc = list._node._inc || list._node.ownerDocument._inc;
    if (list._inc !== inc) {
      var ls = list._refresh(list._node);
      __set__(list, "length", ls.length);
      if (!list.$$length || ls.length < list.$$length) {
        for (var i = ls.length;i in list; i++) {
          if (hasOwn(list, i)) {
            delete list[i];
          }
        }
      }
      copy(ls, list);
      list._inc = inc;
    }
  }
  LiveNodeList.prototype.item = function(i) {
    _updateLiveList(this);
    return this[i] || null;
  };
  _extends(LiveNodeList, NodeList);
  function NamedNodeMap() {
    this._nsIndex = Object.create(null);
    this._noNsIndex = Object.create(null);
  }
  function _findNodeIndex(list, node) {
    var i = 0;
    while (i < list.length) {
      if (list[i] === node) {
        return i;
      }
      i++;
    }
  }
  function _nnmBucket(map, namespaceURI, create) {
    if (!namespaceURI) {
      return map._noNsIndex;
    }
    var bucket = map._nsIndex[namespaceURI];
    if (!bucket && create) {
      bucket = map._nsIndex[namespaceURI] = Object.create(null);
    }
    return bucket;
  }
  function _nnmIndexFind(map, namespaceURI, localName) {
    var bucket = _nnmBucket(map, namespaceURI, false);
    var found = bucket && bucket[localName];
    return found ? found : null;
  }
  function _nnmIndexAdd(map, attr) {
    _nnmBucket(map, attr.namespaceURI, true)[attr.localName] = attr;
  }
  function _nnmIndexRemove(map, attr) {
    var bucket = _nnmBucket(map, attr.namespaceURI, false);
    if (bucket) {
      delete bucket[attr.localName];
    }
  }
  function _addNamedNode(el, list, newAttr, oldAttr) {
    if (oldAttr) {
      list[_findNodeIndex(list, oldAttr)] = newAttr;
    } else {
      list[list.length] = newAttr;
      list.length++;
    }
    _nnmIndexAdd(list, newAttr);
    if (el) {
      newAttr.ownerElement = el;
      var doc = el.ownerDocument;
      if (doc) {
        oldAttr && _onRemoveAttribute(doc, el, oldAttr);
        _onAddAttribute(doc, el, newAttr);
      }
    }
  }
  function _removeNamedNode(el, list, attr) {
    var i = _findNodeIndex(list, attr);
    if (i >= 0) {
      var lastIndex = list.length - 1;
      while (i <= lastIndex) {
        list[i] = list[++i];
      }
      list.length = lastIndex;
      _nnmIndexRemove(list, attr);
      if (el) {
        var doc = el.ownerDocument;
        if (doc) {
          _onRemoveAttribute(doc, el, attr);
        }
        attr.ownerElement = null;
      }
    }
  }
  NamedNodeMap.prototype = {
    length: 0,
    item: NodeList.prototype.item,
    getNamedItem: function(localName) {
      if (this._ownerElement && this._ownerElement._isInHTMLDocumentAndNamespace()) {
        localName = localName.toLowerCase();
      }
      var i = 0;
      while (i < this.length) {
        var attr = this[i];
        if (attr.nodeName === localName) {
          return attr;
        }
        i++;
      }
      return null;
    },
    setNamedItem: function(attr) {
      var el = attr.ownerElement;
      if (el && el !== this._ownerElement) {
        throw new DOMException(DOMException.INUSE_ATTRIBUTE_ERR);
      }
      var oldAttr = _nnmIndexFind(this, attr.namespaceURI, attr.localName);
      if (oldAttr === attr) {
        return attr;
      }
      _addNamedNode(this._ownerElement, this, attr, oldAttr);
      return oldAttr;
    },
    setNamedItemNS: function(attr) {
      return this.setNamedItem(attr);
    },
    removeNamedItem: function(localName) {
      var attr = this.getNamedItem(localName);
      if (!attr) {
        throw new DOMException(DOMException.NOT_FOUND_ERR, localName);
      }
      _removeNamedNode(this._ownerElement, this, attr);
      return attr;
    },
    removeNamedItemNS: function(namespaceURI, localName) {
      var attr = this.getNamedItemNS(namespaceURI, localName);
      if (!attr) {
        throw new DOMException(DOMException.NOT_FOUND_ERR, namespaceURI ? namespaceURI + " : " + localName : localName);
      }
      _removeNamedNode(this._ownerElement, this, attr);
      return attr;
    },
    getNamedItemNS: function(namespaceURI, localName) {
      if (!namespaceURI) {
        namespaceURI = null;
      }
      var i = 0;
      while (i < this.length) {
        var node = this[i];
        if (node.localName === localName && node.namespaceURI === namespaceURI) {
          return node;
        }
        i++;
      }
      return null;
    }
  };
  NamedNodeMap.prototype[Symbol.iterator] = function() {
    var me = this;
    var index = 0;
    return {
      next: function() {
        if (index < me.length) {
          return {
            value: me[index++],
            done: false
          };
        } else {
          return {
            done: true
          };
        }
      },
      return: function() {
        return {
          done: true
        };
      }
    };
  };
  function DOMImplementation() {}
  DOMImplementation.prototype = {
    hasFeature: function(feature, version) {
      return true;
    },
    createDocument: function(namespaceURI, qualifiedName, doctype) {
      var contentType = MIME_TYPE.XML_APPLICATION;
      if (namespaceURI === NAMESPACE.HTML) {
        contentType = MIME_TYPE.XML_XHTML_APPLICATION;
      } else if (namespaceURI === NAMESPACE.SVG) {
        contentType = MIME_TYPE.XML_SVG_IMAGE;
      }
      var doc = new Document(PDC, { contentType });
      doc.implementation = this;
      doc.childNodes = new NodeList;
      doc.doctype = doctype || null;
      if (doctype) {
        doc.appendChild(doctype);
      }
      if (qualifiedName) {
        var root = doc.createElementNS(namespaceURI, qualifiedName);
        doc.appendChild(root);
      }
      return doc;
    },
    createDocumentType: function(qualifiedName, publicId, systemId, internalSubset) {
      validateQualifiedName(qualifiedName);
      var node = new DocumentType(PDC);
      node.name = qualifiedName;
      node.nodeName = qualifiedName;
      node.publicId = publicId || "";
      node.systemId = systemId || "";
      node.internalSubset = internalSubset || "";
      node.childNodes = new NodeList;
      return node;
    },
    createHTMLDocument: function(title) {
      var doc = new Document(PDC, { contentType: MIME_TYPE.HTML });
      doc.implementation = this;
      doc.childNodes = new NodeList;
      if (title !== false) {
        doc.doctype = this.createDocumentType("html");
        doc.doctype.ownerDocument = doc;
        doc.appendChild(doc.doctype);
        var htmlNode = doc.createElement("html");
        doc.appendChild(htmlNode);
        var headNode = doc.createElement("head");
        htmlNode.appendChild(headNode);
        if (typeof title === "string") {
          var titleNode = doc.createElement("title");
          titleNode.appendChild(doc.createTextNode(title));
          headNode.appendChild(titleNode);
        }
        htmlNode.appendChild(doc.createElement("body"));
      }
      return doc;
    }
  };
  function Node(symbol) {
    checkSymbol(symbol);
  }
  Node.prototype = {
    firstChild: null,
    lastChild: null,
    previousSibling: null,
    nextSibling: null,
    parentNode: null,
    get parentElement() {
      return this.parentNode && this.parentNode.nodeType === this.ELEMENT_NODE ? this.parentNode : null;
    },
    childNodes: null,
    ownerDocument: null,
    nodeValue: null,
    namespaceURI: null,
    prefix: null,
    localName: null,
    baseURI: "about:blank",
    get isConnected() {
      var rootNode = this.getRootNode();
      return rootNode && rootNode.nodeType === rootNode.DOCUMENT_NODE;
    },
    contains: function(other) {
      if (!other)
        return false;
      var parent = other;
      do {
        if (this === parent)
          return true;
        parent = parent.parentNode;
      } while (parent);
      return false;
    },
    getRootNode: function(options2) {
      var parent = this;
      do {
        if (!parent.parentNode) {
          return parent;
        }
        parent = parent.parentNode;
      } while (parent);
    },
    isEqualNode: function(otherNode) {
      if (!otherNode)
        return false;
      var stack = [{ node: this, other: otherNode }];
      while (stack.length > 0) {
        var pair = stack.pop();
        var node = pair.node;
        var other = pair.other;
        if (node.nodeType !== other.nodeType)
          return false;
        switch (node.nodeType) {
          case node.DOCUMENT_TYPE_NODE:
            if (node.name !== other.name)
              return false;
            if (node.publicId !== other.publicId)
              return false;
            if (node.systemId !== other.systemId)
              return false;
            break;
          case node.ELEMENT_NODE:
            if (node.namespaceURI !== other.namespaceURI)
              return false;
            if (node.prefix !== other.prefix)
              return false;
            if (node.localName !== other.localName)
              return false;
            if (node.attributes.length !== other.attributes.length)
              return false;
            for (var i = 0;i < node.attributes.length; i++) {
              var attr = node.attributes.item(i);
              var otherAttr = other.getAttributeNodeNS(attr.namespaceURI, attr.localName);
              if (!otherAttr)
                return false;
              stack.push({ node: attr, other: otherAttr });
            }
            break;
          case node.ATTRIBUTE_NODE:
            if (node.namespaceURI !== other.namespaceURI)
              return false;
            if (node.localName !== other.localName)
              return false;
            if (node.value !== other.value)
              return false;
            break;
          case node.PROCESSING_INSTRUCTION_NODE:
            if (node.target !== other.target || node.data !== other.data)
              return false;
            break;
          case node.TEXT_NODE:
          case node.CDATA_SECTION_NODE:
          case node.COMMENT_NODE:
            if (node.data !== other.data)
              return false;
            break;
        }
        if (node.childNodes.length !== other.childNodes.length)
          return false;
        for (var i = node.childNodes.length - 1;i >= 0; i--) {
          stack.push({ node: node.childNodes[i], other: other.childNodes[i] });
        }
      }
      return true;
    },
    isSameNode: function(otherNode) {
      return this === otherNode;
    },
    insertBefore: function(newChild, refChild) {
      return _insertBefore(this, newChild, refChild);
    },
    replaceChild: function(newChild, oldChild) {
      _insertBefore(this, newChild, oldChild, assertPreReplacementValidityInDocument);
      if (oldChild) {
        this.removeChild(oldChild);
      }
    },
    removeChild: function(oldChild) {
      return _removeChild(this, oldChild);
    },
    appendChild: function(newChild) {
      return this.insertBefore(newChild, null);
    },
    hasChildNodes: function() {
      return this.firstChild != null;
    },
    cloneNode: function(deep) {
      return cloneNode(this.ownerDocument || this, this, deep);
    },
    normalize: function() {
      walkDOM(this, null, {
        enter: function(node) {
          var child = node.firstChild;
          while (child) {
            var next = child.nextSibling;
            if (next !== null && next.nodeType === TEXT_NODE && child.nodeType === TEXT_NODE) {
              var tail = [];
              var sibling = next;
              while (sibling !== null && sibling.nodeType === TEXT_NODE) {
                tail.push(sibling.data);
                sibling = sibling.nextSibling;
              }
              var removed = child.nextSibling;
              while (removed !== sibling) {
                var following = removed.nextSibling;
                removed.parentNode = null;
                removed.previousSibling = null;
                removed.nextSibling = null;
                removed = following;
              }
              child.nextSibling = sibling;
              if (sibling !== null) {
                sibling.previousSibling = child;
              } else {
                node.lastChild = child;
              }
              child.appendData(tail.join(""));
              _onUpdateChild(node.ownerDocument, node);
              child = sibling;
            } else {
              child = next;
            }
          }
          return true;
        }
      });
    },
    isSupported: function(feature, version) {
      return this.ownerDocument.implementation.hasFeature(feature, version);
    },
    lookupPrefix: function(namespaceURI) {
      var el = this;
      while (el) {
        var map = el._nsMap;
        if (map) {
          for (var n in map) {
            if (hasOwn(map, n) && map[n] === namespaceURI) {
              return n;
            }
          }
        }
        el = el.nodeType == ATTRIBUTE_NODE ? el.ownerDocument : el.parentNode;
      }
      return null;
    },
    lookupNamespaceURI: function(prefix) {
      var el = this;
      while (el) {
        var map = el._nsMap;
        if (map) {
          if (hasOwn(map, prefix)) {
            return map[prefix];
          }
        }
        el = el.nodeType == ATTRIBUTE_NODE ? el.ownerDocument : el.parentNode;
      }
      return null;
    },
    isDefaultNamespace: function(namespaceURI) {
      var prefix = this.lookupPrefix(namespaceURI);
      return prefix == null;
    },
    compareDocumentPosition: function(other) {
      if (this === other)
        return 0;
      var node1 = other;
      var node2 = this;
      var attr1 = null;
      var attr2 = null;
      if (node1 instanceof Attr) {
        attr1 = node1;
        node1 = attr1.ownerElement;
      }
      if (node2 instanceof Attr) {
        attr2 = node2;
        node2 = attr2.ownerElement;
        if (attr1 && node1 && node2 === node1) {
          for (var i = 0, attr;attr = node2.attributes[i]; i++) {
            if (attr === attr1)
              return DocumentPosition.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC + DocumentPosition.DOCUMENT_POSITION_PRECEDING;
            if (attr === attr2)
              return DocumentPosition.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC + DocumentPosition.DOCUMENT_POSITION_FOLLOWING;
          }
        }
      }
      if (!node1 || !node2 || node2.ownerDocument !== node1.ownerDocument) {
        return DocumentPosition.DOCUMENT_POSITION_DISCONNECTED + DocumentPosition.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC + (docGUID(node2.ownerDocument) > docGUID(node1.ownerDocument) ? DocumentPosition.DOCUMENT_POSITION_FOLLOWING : DocumentPosition.DOCUMENT_POSITION_PRECEDING);
      }
      if (attr2 && node1 === node2) {
        return DocumentPosition.DOCUMENT_POSITION_CONTAINS + DocumentPosition.DOCUMENT_POSITION_PRECEDING;
      }
      if (attr1 && node1 === node2) {
        return DocumentPosition.DOCUMENT_POSITION_CONTAINED_BY + DocumentPosition.DOCUMENT_POSITION_FOLLOWING;
      }
      var chain1 = [];
      var ancestor1 = node1.parentNode;
      while (ancestor1) {
        if (!attr2 && ancestor1 === node2) {
          return DocumentPosition.DOCUMENT_POSITION_CONTAINED_BY + DocumentPosition.DOCUMENT_POSITION_FOLLOWING;
        }
        chain1.push(ancestor1);
        ancestor1 = ancestor1.parentNode;
      }
      chain1.reverse();
      var chain2 = [];
      var ancestor2 = node2.parentNode;
      while (ancestor2) {
        if (!attr1 && ancestor2 === node1) {
          return DocumentPosition.DOCUMENT_POSITION_CONTAINS + DocumentPosition.DOCUMENT_POSITION_PRECEDING;
        }
        chain2.push(ancestor2);
        ancestor2 = ancestor2.parentNode;
      }
      chain2.reverse();
      var ca = commonAncestor(chain1, chain2);
      for (var n in ca.childNodes) {
        var child = ca.childNodes[n];
        if (child === node2)
          return DocumentPosition.DOCUMENT_POSITION_FOLLOWING;
        if (child === node1)
          return DocumentPosition.DOCUMENT_POSITION_PRECEDING;
        if (chain2.indexOf(child) >= 0)
          return DocumentPosition.DOCUMENT_POSITION_FOLLOWING;
        if (chain1.indexOf(child) >= 0)
          return DocumentPosition.DOCUMENT_POSITION_PRECEDING;
      }
      return 0;
    }
  };
  function _xmlEncoder(c) {
    return c == "<" && "&lt;" || c == ">" && "&gt;" || c == "&" && "&amp;" || c == '"' && "&quot;" || "&#" + c.charCodeAt() + ";";
  }
  copy(NodeType, Node);
  copy(NodeType, Node.prototype);
  copy(DocumentPosition, Node);
  copy(DocumentPosition, Node.prototype);
  function _visitNode(node, callback) {
    walkDOM(node, null, {
      enter: function(n) {
        return callback(n) ? walkDOM.STOP : true;
      }
    });
  }
  function walkDOM(node, context, callbacks) {
    var stack = [{ node, context, phase: walkDOM.ENTER }];
    while (stack.length > 0) {
      var frame = stack.pop();
      if (frame.phase === walkDOM.ENTER) {
        var childContext = callbacks.enter(frame.node, frame.context);
        if (childContext === walkDOM.STOP) {
          return walkDOM.STOP;
        }
        stack.push({ node: frame.node, context: childContext, phase: walkDOM.EXIT });
        if (childContext === null || childContext === undefined) {
          continue;
        }
        var child = frame.node.lastChild;
        while (child) {
          stack.push({ node: child, context: childContext, phase: walkDOM.ENTER });
          child = child.previousSibling;
        }
      } else {
        if (callbacks.exit) {
          callbacks.exit(frame.node, frame.context);
        }
      }
    }
  }
  walkDOM.STOP = Symbol("walkDOM.STOP");
  walkDOM.ENTER = 0;
  walkDOM.EXIT = 1;
  function Document(symbol, options2) {
    checkSymbol(symbol);
    var opt = options2 || {};
    this.ownerDocument = this;
    this.contentType = opt.contentType || MIME_TYPE.XML_APPLICATION;
    this.type = isHTMLMimeType(this.contentType) ? "html" : "xml";
  }
  function _onAddAttribute(doc, el, newAttr) {
    doc && doc._inc++;
    var ns = newAttr.namespaceURI;
    if (ns === NAMESPACE.XMLNS) {
      el._nsMap[newAttr.prefix ? newAttr.localName : ""] = newAttr.value;
    }
  }
  function _onRemoveAttribute(doc, el, newAttr, remove) {
    doc && doc._inc++;
    var ns = newAttr.namespaceURI;
    if (ns === NAMESPACE.XMLNS) {
      delete el._nsMap[newAttr.prefix ? newAttr.localName : ""];
    }
  }
  function _onUpdateChild(doc, parent, newChild) {
    if (doc && doc._inc) {
      doc._inc++;
      var childNodes = parent.childNodes;
      if (newChild && !newChild.nextSibling) {
        childNodes[childNodes.length++] = newChild;
      } else {
        var child = parent.firstChild;
        var i = 0;
        while (child) {
          childNodes[i++] = child;
          child = child.nextSibling;
        }
        childNodes.length = i;
        delete childNodes[childNodes.length];
      }
    }
  }
  function _removeChild(parentNode, child) {
    if (parentNode !== child.parentNode) {
      throw new DOMException(DOMException.NOT_FOUND_ERR, "child's parent is not parent");
    }
    var oldPreviousSibling = child.previousSibling;
    var oldNextSibling = child.nextSibling;
    if (oldPreviousSibling) {
      oldPreviousSibling.nextSibling = oldNextSibling;
    } else {
      parentNode.firstChild = oldNextSibling;
    }
    if (oldNextSibling) {
      oldNextSibling.previousSibling = oldPreviousSibling;
    } else {
      parentNode.lastChild = oldPreviousSibling;
    }
    _onUpdateChild(parentNode.ownerDocument, parentNode);
    child.parentNode = null;
    child.previousSibling = null;
    child.nextSibling = null;
    return child;
  }
  function hasValidParentNodeType(node) {
    return node && (node.nodeType === Node.DOCUMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE || node.nodeType === Node.ELEMENT_NODE);
  }
  function hasInsertableNodeType(node) {
    return node && (node.nodeType === Node.CDATA_SECTION_NODE || node.nodeType === Node.COMMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE || node.nodeType === Node.DOCUMENT_TYPE_NODE || node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.PROCESSING_INSTRUCTION_NODE || node.nodeType === Node.TEXT_NODE);
  }
  function isDocTypeNode(node) {
    return node && node.nodeType === Node.DOCUMENT_TYPE_NODE;
  }
  function isElementNode(node) {
    return node && node.nodeType === Node.ELEMENT_NODE;
  }
  function isTextNode(node) {
    return node && node.nodeType === Node.TEXT_NODE;
  }
  function isElementInsertionPossible(doc, child) {
    var parentChildNodes = doc.childNodes || [];
    if (find(parentChildNodes, isElementNode) || isDocTypeNode(child)) {
      return false;
    }
    var docTypeNode = find(parentChildNodes, isDocTypeNode);
    return !(child && docTypeNode && parentChildNodes.indexOf(docTypeNode) > parentChildNodes.indexOf(child));
  }
  function isElementReplacementPossible(doc, child) {
    var parentChildNodes = doc.childNodes || [];
    function hasElementChildThatIsNotChild(node) {
      return isElementNode(node) && node !== child;
    }
    if (find(parentChildNodes, hasElementChildThatIsNotChild)) {
      return false;
    }
    var docTypeNode = find(parentChildNodes, isDocTypeNode);
    return !(child && docTypeNode && parentChildNodes.indexOf(docTypeNode) > parentChildNodes.indexOf(child));
  }
  function assertPreInsertionValidity1to5(parent, node, child) {
    if (!hasValidParentNodeType(parent)) {
      throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Unexpected parent node type " + parent.nodeType);
    }
    if (child && child.parentNode !== parent) {
      throw new DOMException(DOMException.NOT_FOUND_ERR, "child not in parent");
    }
    if (!hasInsertableNodeType(node) || isDocTypeNode(node) && parent.nodeType !== Node.DOCUMENT_NODE) {
      throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Unexpected node type " + node.nodeType + " for parent node type " + parent.nodeType);
    }
  }
  function assertPreInsertionValidityInDocument(parent, node, child) {
    var parentChildNodes = parent.childNodes || [];
    var nodeChildNodes = node.childNodes || [];
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      var nodeChildElements = nodeChildNodes.filter(isElementNode);
      if (nodeChildElements.length > 1 || find(nodeChildNodes, isTextNode)) {
        throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "More than one element or text in fragment");
      }
      if (nodeChildElements.length === 1 && !isElementInsertionPossible(parent, child)) {
        throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Element in fragment can not be inserted before doctype");
      }
    }
    if (isElementNode(node)) {
      if (!isElementInsertionPossible(parent, child)) {
        throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Only one element can be added and only after doctype");
      }
    }
    if (isDocTypeNode(node)) {
      if (find(parentChildNodes, isDocTypeNode)) {
        throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Only one doctype is allowed");
      }
      var parentElementChild = find(parentChildNodes, isElementNode);
      if (child && parentChildNodes.indexOf(parentElementChild) < parentChildNodes.indexOf(child)) {
        throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Doctype can only be inserted before an element");
      }
      if (!child && parentElementChild) {
        throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Doctype can not be appended since element is present");
      }
    }
  }
  function assertPreReplacementValidityInDocument(parent, node, child) {
    var parentChildNodes = parent.childNodes || [];
    var nodeChildNodes = node.childNodes || [];
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      var nodeChildElements = nodeChildNodes.filter(isElementNode);
      if (nodeChildElements.length > 1 || find(nodeChildNodes, isTextNode)) {
        throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "More than one element or text in fragment");
      }
      if (nodeChildElements.length === 1 && !isElementReplacementPossible(parent, child)) {
        throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Element in fragment can not be inserted before doctype");
      }
    }
    if (isElementNode(node)) {
      if (!isElementReplacementPossible(parent, child)) {
        throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Only one element can be added and only after doctype");
      }
    }
    if (isDocTypeNode(node)) {
      let hasDoctypeChildThatIsNotChild = function(node) {
        return isDocTypeNode(node) && node !== child;
      };
      if (find(parentChildNodes, hasDoctypeChildThatIsNotChild)) {
        throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Only one doctype is allowed");
      }
      var parentElementChild = find(parentChildNodes, isElementNode);
      if (child && parentChildNodes.indexOf(parentElementChild) < parentChildNodes.indexOf(child)) {
        throw new DOMException(DOMException.HIERARCHY_REQUEST_ERR, "Doctype can only be inserted before an element");
      }
    }
  }
  function _insertBefore(parent, node, child, _inDocumentAssertion) {
    assertPreInsertionValidity1to5(parent, node, child);
    if (parent.nodeType === Node.DOCUMENT_NODE) {
      (_inDocumentAssertion || assertPreInsertionValidityInDocument)(parent, node, child);
    }
    var cp = node.parentNode;
    if (cp) {
      cp.removeChild(node);
    }
    if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
      var newFirst = node.firstChild;
      if (newFirst == null) {
        return node;
      }
      var newLast = node.lastChild;
    } else {
      newFirst = newLast = node;
    }
    var pre = child ? child.previousSibling : parent.lastChild;
    newFirst.previousSibling = pre;
    newLast.nextSibling = child;
    if (pre) {
      pre.nextSibling = newFirst;
    } else {
      parent.firstChild = newFirst;
    }
    if (child == null) {
      parent.lastChild = newLast;
    } else {
      child.previousSibling = newLast;
    }
    do {
      newFirst.parentNode = parent;
    } while (newFirst !== newLast && (newFirst = newFirst.nextSibling));
    _onUpdateChild(parent.ownerDocument || parent, parent, node);
    if (node.nodeType == DOCUMENT_FRAGMENT_NODE) {
      node.firstChild = node.lastChild = null;
    }
    return node;
  }
  Document.prototype = {
    implementation: null,
    nodeName: "#document",
    nodeType: DOCUMENT_NODE,
    doctype: null,
    documentElement: null,
    _inc: 1,
    insertBefore: function(newChild, refChild) {
      if (newChild.nodeType === DOCUMENT_FRAGMENT_NODE) {
        var child = newChild.firstChild;
        while (child) {
          var next = child.nextSibling;
          this.insertBefore(child, refChild);
          child = next;
        }
        return newChild;
      }
      _insertBefore(this, newChild, refChild);
      newChild.ownerDocument = this;
      if (this.documentElement === null && newChild.nodeType === ELEMENT_NODE) {
        this.documentElement = newChild;
      }
      return newChild;
    },
    removeChild: function(oldChild) {
      var removed = _removeChild(this, oldChild);
      if (removed === this.documentElement) {
        this.documentElement = null;
      }
      return removed;
    },
    replaceChild: function(newChild, oldChild) {
      _insertBefore(this, newChild, oldChild, assertPreReplacementValidityInDocument);
      newChild.ownerDocument = this;
      if (oldChild) {
        this.removeChild(oldChild);
      }
      if (isElementNode(newChild)) {
        this.documentElement = newChild;
      }
    },
    importNode: function(importedNode, deep) {
      return importNode(this, importedNode, deep);
    },
    getElementById: function(id) {
      var rtv = null;
      _visitNode(this.documentElement, function(node) {
        if (node.nodeType == ELEMENT_NODE) {
          if (node.getAttribute("id") == id) {
            rtv = node;
            return true;
          }
        }
      });
      return rtv;
    },
    createElement: function(tagName) {
      var node = new Element(PDC);
      node.ownerDocument = this;
      if (this.type === "html") {
        tagName = tagName.toLowerCase();
      }
      if (hasDefaultHTMLNamespace(this.contentType)) {
        node.namespaceURI = NAMESPACE.HTML;
      }
      node.nodeName = tagName;
      node.tagName = tagName;
      node.localName = tagName;
      node.childNodes = new NodeList;
      var attrs = node.attributes = new NamedNodeMap;
      attrs._ownerElement = node;
      return node;
    },
    createDocumentFragment: function() {
      var node = new DocumentFragment(PDC);
      node.ownerDocument = this;
      node.childNodes = new NodeList;
      return node;
    },
    createTextNode: function(data) {
      var node = new Text(PDC);
      node.ownerDocument = this;
      node.childNodes = new NodeList;
      node.appendData(data);
      return node;
    },
    createComment: function(data) {
      var node = new Comment(PDC);
      node.ownerDocument = this;
      node.childNodes = new NodeList;
      node.appendData(data);
      return node;
    },
    createCDATASection: function(data) {
      if (data.indexOf("]]>") !== -1) {
        throw new DOMException(DOMException.INVALID_CHARACTER_ERR, 'data contains "]]>"');
      }
      var node = new CDATASection(PDC);
      node.ownerDocument = this;
      node.childNodes = new NodeList;
      node.appendData(data);
      return node;
    },
    createProcessingInstruction: function(target, data) {
      var node = new ProcessingInstruction(PDC);
      node.ownerDocument = this;
      node.childNodes = new NodeList;
      node.nodeName = node.target = target;
      node.nodeValue = node.data = data;
      return node;
    },
    createAttribute: function(name) {
      if (!g.QName_exact.test(name)) {
        throw new DOMException(DOMException.INVALID_CHARACTER_ERR, 'invalid character in name "' + name + '"');
      }
      if (this.type === "html") {
        name = name.toLowerCase();
      }
      return this._createAttribute(name);
    },
    _createAttribute: function(name) {
      var node = new Attr(PDC);
      node.ownerDocument = this;
      node.childNodes = new NodeList;
      node.name = name;
      node.nodeName = name;
      node.localName = name;
      node.specified = true;
      return node;
    },
    createEntityReference: function(name) {
      if (!g.Name_exact.test(name)) {
        throw new DOMException(DOMException.INVALID_CHARACTER_ERR, 'not a valid xml name "' + name + '"');
      }
      if (this.type === "html") {
        throw new DOMException("document is an html document", DOMExceptionName.NotSupportedError);
      }
      var node = new EntityReference(PDC);
      node.ownerDocument = this;
      node.childNodes = new NodeList;
      node.nodeName = name;
      return node;
    },
    createElementNS: function(namespaceURI, qualifiedName) {
      var validated = validateAndExtract(namespaceURI, qualifiedName);
      var node = new Element(PDC);
      var attrs = node.attributes = new NamedNodeMap;
      node.childNodes = new NodeList;
      node.ownerDocument = this;
      node.nodeName = qualifiedName;
      node.tagName = qualifiedName;
      node.namespaceURI = validated[0];
      node.prefix = validated[1];
      node.localName = validated[2];
      attrs._ownerElement = node;
      return node;
    },
    createAttributeNS: function(namespaceURI, qualifiedName) {
      var validated = validateAndExtract(namespaceURI, qualifiedName);
      var node = new Attr(PDC);
      node.ownerDocument = this;
      node.childNodes = new NodeList;
      node.nodeName = qualifiedName;
      node.name = qualifiedName;
      node.specified = true;
      node.namespaceURI = validated[0];
      node.prefix = validated[1];
      node.localName = validated[2];
      return node;
    }
  };
  _extends(Document, Node);
  function Element(symbol) {
    checkSymbol(symbol);
    this._nsMap = Object.create(null);
  }
  Element.prototype = {
    nodeType: ELEMENT_NODE,
    attributes: null,
    getQualifiedName: function() {
      return this.prefix ? this.prefix + ":" + this.localName : this.localName;
    },
    _isInHTMLDocumentAndNamespace: function() {
      return this.ownerDocument.type === "html" && this.namespaceURI === NAMESPACE.HTML;
    },
    hasAttributes: function() {
      return !!(this.attributes && this.attributes.length);
    },
    hasAttribute: function(name) {
      return !!this.getAttributeNode(name);
    },
    getAttribute: function(name) {
      var attr = this.getAttributeNode(name);
      return attr ? attr.value : null;
    },
    getAttributeNode: function(name) {
      if (this._isInHTMLDocumentAndNamespace()) {
        name = name.toLowerCase();
      }
      return this.attributes.getNamedItem(name);
    },
    setAttribute: function(name, value) {
      if (this._isInHTMLDocumentAndNamespace()) {
        name = name.toLowerCase();
      }
      var attr = this.getAttributeNode(name);
      if (attr) {
        attr.value = attr.nodeValue = "" + value;
      } else {
        attr = this.ownerDocument._createAttribute(name);
        attr.value = attr.nodeValue = "" + value;
        this.setAttributeNode(attr);
      }
    },
    removeAttribute: function(name) {
      var attr = this.getAttributeNode(name);
      attr && this.removeAttributeNode(attr);
    },
    setAttributeNode: function(newAttr) {
      return this.attributes.setNamedItem(newAttr);
    },
    setAttributeNodeNS: function(newAttr) {
      return this.attributes.setNamedItemNS(newAttr);
    },
    removeAttributeNode: function(oldAttr) {
      return this.attributes.removeNamedItem(oldAttr.nodeName);
    },
    removeAttributeNS: function(namespaceURI, localName) {
      var old = this.getAttributeNodeNS(namespaceURI, localName);
      old && this.removeAttributeNode(old);
    },
    hasAttributeNS: function(namespaceURI, localName) {
      return this.getAttributeNodeNS(namespaceURI, localName) != null;
    },
    getAttributeNS: function(namespaceURI, localName) {
      var attr = this.getAttributeNodeNS(namespaceURI, localName);
      return attr ? attr.value : null;
    },
    setAttributeNS: function(namespaceURI, qualifiedName, value) {
      var validated = validateAndExtract(namespaceURI, qualifiedName);
      var localName = validated[2];
      var attr = this.getAttributeNodeNS(namespaceURI, localName);
      if (attr) {
        attr.value = attr.nodeValue = "" + value;
      } else {
        attr = this.ownerDocument.createAttributeNS(namespaceURI, qualifiedName);
        attr.value = attr.nodeValue = "" + value;
        this.setAttributeNode(attr);
      }
    },
    getAttributeNodeNS: function(namespaceURI, localName) {
      return this.attributes.getNamedItemNS(namespaceURI, localName);
    },
    getElementsByClassName: function(classNames) {
      var classNamesSet = toOrderedSet(classNames);
      return new LiveNodeList(this, function(base) {
        var ls = [];
        if (classNamesSet.length > 0) {
          _visitNode(base, function(node) {
            if (node !== base && node.nodeType === ELEMENT_NODE) {
              var nodeClassNames = node.getAttribute("class");
              if (nodeClassNames) {
                var matches = classNames === nodeClassNames;
                if (!matches) {
                  var nodeClassNamesSet = toOrderedSet(nodeClassNames);
                  matches = classNamesSet.every(arrayIncludes(nodeClassNamesSet));
                }
                if (matches) {
                  ls.push(node);
                }
              }
            }
          });
        }
        return ls;
      });
    },
    getElementsByTagName: function(qualifiedName) {
      var isHTMLDocument = (this.nodeType === DOCUMENT_NODE ? this : this.ownerDocument).type === "html";
      var lowerQualifiedName = qualifiedName.toLowerCase();
      return new LiveNodeList(this, function(base) {
        var ls = [];
        _visitNode(base, function(node) {
          if (node === base || node.nodeType !== ELEMENT_NODE) {
            return;
          }
          if (qualifiedName === "*") {
            ls.push(node);
          } else {
            var nodeQualifiedName = node.getQualifiedName();
            var matchingQName = isHTMLDocument && node.namespaceURI === NAMESPACE.HTML ? lowerQualifiedName : qualifiedName;
            if (nodeQualifiedName === matchingQName) {
              ls.push(node);
            }
          }
        });
        return ls;
      });
    },
    getElementsByTagNameNS: function(namespaceURI, localName) {
      return new LiveNodeList(this, function(base) {
        var ls = [];
        _visitNode(base, function(node) {
          if (node !== base && node.nodeType === ELEMENT_NODE && (namespaceURI === "*" || node.namespaceURI === namespaceURI) && (localName === "*" || node.localName == localName)) {
            ls.push(node);
          }
        });
        return ls;
      });
    }
  };
  Document.prototype.getElementsByClassName = Element.prototype.getElementsByClassName;
  Document.prototype.getElementsByTagName = Element.prototype.getElementsByTagName;
  Document.prototype.getElementsByTagNameNS = Element.prototype.getElementsByTagNameNS;
  _extends(Element, Node);
  function Attr(symbol) {
    checkSymbol(symbol);
    this.namespaceURI = null;
    this.prefix = null;
    this.ownerElement = null;
  }
  Attr.prototype.nodeType = ATTRIBUTE_NODE;
  _extends(Attr, Node);
  function CharacterData(symbol) {
    checkSymbol(symbol);
  }
  CharacterData.prototype = {
    data: "",
    substringData: function(offset, count) {
      return this.data.substring(offset, offset + count);
    },
    appendData: function(text) {
      text = this.data + text;
      this.nodeValue = this.data = text;
      this.length = text.length;
    },
    insertData: function(offset, text) {
      this.replaceData(offset, 0, text);
    },
    deleteData: function(offset, count) {
      this.replaceData(offset, count, "");
    },
    replaceData: function(offset, count, text) {
      var start = this.data.substring(0, offset);
      var end = this.data.substring(offset + count);
      text = start + text + end;
      this.nodeValue = this.data = text;
      this.length = text.length;
    }
  };
  _extends(CharacterData, Node);
  function Text(symbol) {
    checkSymbol(symbol);
  }
  Text.prototype = {
    nodeName: "#text",
    nodeType: TEXT_NODE,
    splitText: function(offset) {
      var text = this.data;
      var newText = text.substring(offset);
      text = text.substring(0, offset);
      this.data = this.nodeValue = text;
      this.length = text.length;
      var newNode = this.ownerDocument.createTextNode(newText);
      if (this.parentNode) {
        this.parentNode.insertBefore(newNode, this.nextSibling);
      }
      return newNode;
    }
  };
  _extends(Text, CharacterData);
  function Comment(symbol) {
    checkSymbol(symbol);
  }
  Comment.prototype = {
    nodeName: "#comment",
    nodeType: COMMENT_NODE
  };
  _extends(Comment, CharacterData);
  function CDATASection(symbol) {
    checkSymbol(symbol);
  }
  CDATASection.prototype = {
    nodeName: "#cdata-section",
    nodeType: CDATA_SECTION_NODE
  };
  _extends(CDATASection, Text);
  function DocumentType(symbol) {
    checkSymbol(symbol);
  }
  DocumentType.prototype.nodeType = DOCUMENT_TYPE_NODE;
  _extends(DocumentType, Node);
  function Notation(symbol) {
    checkSymbol(symbol);
  }
  Notation.prototype.nodeType = NOTATION_NODE;
  _extends(Notation, Node);
  function Entity(symbol) {
    checkSymbol(symbol);
  }
  Entity.prototype.nodeType = ENTITY_NODE;
  _extends(Entity, Node);
  function EntityReference(symbol) {
    checkSymbol(symbol);
  }
  EntityReference.prototype.nodeType = ENTITY_REFERENCE_NODE;
  _extends(EntityReference, Node);
  function DocumentFragment(symbol) {
    checkSymbol(symbol);
  }
  DocumentFragment.prototype.nodeName = "#document-fragment";
  DocumentFragment.prototype.nodeType = DOCUMENT_FRAGMENT_NODE;
  _extends(DocumentFragment, Node);
  function ProcessingInstruction(symbol) {
    checkSymbol(symbol);
  }
  ProcessingInstruction.prototype.nodeType = PROCESSING_INSTRUCTION_NODE;
  _extends(ProcessingInstruction, CharacterData);
  function XMLSerializer() {}
  XMLSerializer.prototype.serializeToString = function(node, options2) {
    return nodeSerializeToString.call(node, options2);
  };
  Node.prototype.toString = nodeSerializeToString;
  function nodeSerializeToString(options2) {
    var opts;
    if (typeof options2 === "function") {
      opts = { requireWellFormed: false, splitCDATASections: true, nodeFilter: options2 };
    } else if (options2 != null) {
      opts = {
        requireWellFormed: !!options2.requireWellFormed,
        splitCDATASections: options2.splitCDATASections !== false,
        nodeFilter: options2.nodeFilter || null
      };
    } else {
      opts = { requireWellFormed: false, splitCDATASections: true, nodeFilter: null };
    }
    var buf = [];
    var refNode = this.nodeType === DOCUMENT_NODE && this.documentElement || this;
    var prefix = refNode.prefix;
    var uri = refNode.namespaceURI;
    if (uri && prefix == null) {
      var prefix = refNode.lookupPrefix(uri);
      if (prefix == null) {
        var visibleNamespaces = [
          { namespace: uri, prefix: null }
        ];
      }
    }
    serializeToString(this, buf, visibleNamespaces, opts);
    return buf.join("");
  }
  function needNamespaceDefine(node, isHTML, visibleNamespaces) {
    var prefix = node.prefix || "";
    var uri = node.namespaceURI;
    if (!uri) {
      return false;
    }
    if (prefix === "xml" && uri === NAMESPACE.XML || uri === NAMESPACE.XMLNS) {
      return false;
    }
    var i = visibleNamespaces.length;
    while (i--) {
      var ns = visibleNamespaces[i];
      if (ns.prefix === prefix) {
        return ns.namespace !== uri;
      }
    }
    return true;
  }
  function addSerializedAttribute(buf, qualifiedName, value, requireWellFormed) {
    if (requireWellFormed && !g.QName_exact.test(qualifiedName)) {
      throw new DOMException('The attribute name "' + qualifiedName + '" is not a valid XML QName', DOMExceptionName.InvalidStateError);
    }
    buf.push(" ", qualifiedName, '="', value.replace(/[<>&"\t\n\r]/g, _xmlEncoder), '"');
  }
  function serializeToString(node, buf, visibleNamespaces, opts) {
    if (!visibleNamespaces) {
      visibleNamespaces = [];
    }
    var nodeFilter = opts.nodeFilter;
    var requireWellFormed = opts.requireWellFormed;
    var splitCDATASections = opts.splitCDATASections;
    var doc = node.nodeType === DOCUMENT_NODE ? node : node.ownerDocument;
    var isHTML = doc.type === "html";
    walkDOM(node, { ns: visibleNamespaces }, {
      enter: function(n, ctx) {
        var namespaces = ctx.ns;
        if (nodeFilter) {
          n = nodeFilter(n);
          if (n) {
            if (typeof n == "string") {
              buf.push(n);
              return null;
            }
          } else {
            return null;
          }
        }
        switch (n.nodeType) {
          case ELEMENT_NODE:
            var attrs = n.attributes;
            var len = attrs.length;
            var nodeName = n.tagName;
            var prefixedNodeName = nodeName;
            if (!isHTML && !n.prefix && n.namespaceURI) {
              var defaultNS;
              for (var ai = 0;ai < attrs.length; ai++) {
                if (attrs.item(ai).name === "xmlns") {
                  defaultNS = attrs.item(ai).value;
                  break;
                }
              }
              if (!defaultNS) {
                for (var nsi = namespaces.length - 1;nsi >= 0; nsi--) {
                  var nsEntry = namespaces[nsi];
                  if (nsEntry.prefix === "" && nsEntry.namespace === n.namespaceURI) {
                    defaultNS = nsEntry.namespace;
                    break;
                  }
                }
              }
              if (defaultNS !== n.namespaceURI) {
                for (var nsi = namespaces.length - 1;nsi >= 0; nsi--) {
                  var nsEntry = namespaces[nsi];
                  if (nsEntry.namespace === n.namespaceURI) {
                    if (nsEntry.prefix) {
                      prefixedNodeName = nsEntry.prefix + ":" + nodeName;
                    }
                    break;
                  }
                }
              }
            }
            if (requireWellFormed && !g.QName_exact.test(prefixedNodeName)) {
              throw new DOMException('The element name "' + prefixedNodeName + '" is not a valid XML QName', DOMExceptionName.InvalidStateError);
            }
            buf.push("<", prefixedNodeName);
            var childNamespaces = namespaces.slice();
            for (var i = 0;i < len; i++) {
              var attr = attrs.item(i);
              if (attr.prefix == "xmlns") {
                childNamespaces.push({
                  prefix: attr.localName,
                  namespace: attr.value
                });
              } else if (attr.nodeName == "xmlns") {
                childNamespaces.push({ prefix: "", namespace: attr.value });
              }
            }
            for (var i = 0;i < len; i++) {
              var attr = attrs.item(i);
              if (needNamespaceDefine(attr, isHTML, childNamespaces)) {
                var attrPrefix = attr.prefix || "";
                var uri = attr.namespaceURI;
                addSerializedAttribute(buf, attrPrefix ? "xmlns:" + attrPrefix : "xmlns", uri, requireWellFormed);
                childNamespaces.push({ prefix: attrPrefix, namespace: uri });
              }
              var filteredAttr = nodeFilter ? nodeFilter(attr) : attr;
              if (filteredAttr) {
                if (typeof filteredAttr === "string") {
                  buf.push(filteredAttr);
                } else {
                  addSerializedAttribute(buf, filteredAttr.name, filteredAttr.value, requireWellFormed);
                }
              }
            }
            if (nodeName === prefixedNodeName && needNamespaceDefine(n, isHTML, childNamespaces)) {
              var nodePrefix = n.prefix || "";
              var uri = n.namespaceURI;
              addSerializedAttribute(buf, nodePrefix ? "xmlns:" + nodePrefix : "xmlns", uri, requireWellFormed);
              childNamespaces.push({ prefix: nodePrefix, namespace: uri });
            }
            var canCloseTag = !n.firstChild;
            if (canCloseTag && (isHTML || n.namespaceURI === NAMESPACE.HTML)) {
              canCloseTag = isHTMLVoidElement(nodeName);
            }
            if (canCloseTag) {
              buf.push("/>");
              return null;
            }
            buf.push(">");
            if (isHTML && isHTMLRawTextElement(nodeName)) {
              var child = n.firstChild;
              while (child) {
                if (child.data) {
                  buf.push(child.data);
                } else {
                  serializeToString(child, buf, childNamespaces.slice(), opts);
                }
                child = child.nextSibling;
              }
              buf.push("</", prefixedNodeName, ">");
              return null;
            }
            return { ns: childNamespaces, tag: prefixedNodeName };
          case DOCUMENT_NODE:
          case DOCUMENT_FRAGMENT_NODE:
            if (requireWellFormed && n.nodeType === DOCUMENT_NODE && n.documentElement == null) {
              throw new DOMException("The Document has no documentElement", DOMExceptionName.InvalidStateError);
            }
            return { ns: namespaces };
          case ATTRIBUTE_NODE:
            addSerializedAttribute(buf, n.name, n.value, requireWellFormed);
            return null;
          case TEXT_NODE:
            if (requireWellFormed && g.InvalidChar.test(n.data)) {
              throw new DOMException("The Text node data contains characters outside the XML Char production", DOMExceptionName.InvalidStateError);
            }
            buf.push(n.data.replace(/[<&>]/g, _xmlEncoder));
            return null;
          case CDATA_SECTION_NODE:
            if (requireWellFormed && n.data.indexOf("]]>") !== -1) {
              throw new DOMException('The CDATASection data contains "]]>"', DOMExceptionName.InvalidStateError);
            }
            if (splitCDATASections) {
              buf.push(g.CDATA_START, n.data.replace(/]]>/g, "]]]]><![CDATA[>"), g.CDATA_END);
            } else {
              buf.push(g.CDATA_START, n.data, g.CDATA_END);
            }
            return null;
          case COMMENT_NODE:
            if (requireWellFormed) {
              if (g.InvalidChar.test(n.data)) {
                throw new DOMException("The comment node data contains characters outside the XML Char production", DOMExceptionName.InvalidStateError);
              }
              if (n.data.indexOf("--") !== -1 || n.data[n.data.length - 1] === "-") {
                throw new DOMException('The comment node data contains "--" or ends with "-"', DOMExceptionName.InvalidStateError);
              }
            }
            buf.push(g.COMMENT_START, n.data, g.COMMENT_END);
            return null;
          case DOCUMENT_TYPE_NODE:
            var pubid = n.publicId;
            var sysid = n.systemId;
            if (requireWellFormed) {
              if (!g.Name_exact.test(n.name)) {
                throw new DOMException('The doctype name "' + n.name + '" is not a valid XML Name', DOMExceptionName.InvalidStateError);
              }
              if (pubid && !g.PubidLiteral_match.test(pubid)) {
                throw new DOMException("DocumentType publicId is not a valid PubidLiteral", DOMExceptionName.InvalidStateError);
              }
              if (sysid && sysid !== "." && !g.SystemLiteral_match.test(sysid)) {
                throw new DOMException("DocumentType systemId is not a valid SystemLiteral", DOMExceptionName.InvalidStateError);
              }
              if (n.internalSubset && n.internalSubset.indexOf("]>") !== -1) {
                throw new DOMException('DocumentType internalSubset contains "]>"', DOMExceptionName.InvalidStateError);
              }
            }
            buf.push(g.DOCTYPE_DECL_START, " ", n.name);
            if (pubid) {
              buf.push(" ", g.PUBLIC, " ", pubid);
              if (sysid && sysid !== ".") {
                buf.push(" ", sysid);
              }
            } else if (sysid && sysid !== ".") {
              buf.push(" ", g.SYSTEM, " ", sysid);
            }
            if (n.internalSubset) {
              buf.push(" [", n.internalSubset, "]");
            }
            buf.push(">");
            return null;
          case PROCESSING_INSTRUCTION_NODE:
            if (requireWellFormed) {
              if (!g.NCName_exact.test(n.target) || n.target.toLowerCase() === "xml") {
                throw new DOMException('The processing instruction target "' + n.target + '" is not a valid XML NCName or is reserved', DOMExceptionName.InvalidStateError);
              }
              if (g.InvalidChar.test(n.data)) {
                throw new DOMException("The ProcessingInstruction data contains characters outside the XML Char production", DOMExceptionName.InvalidStateError);
              }
              if (n.data.indexOf("?>") !== -1) {
                throw new DOMException('The ProcessingInstruction data contains "?>"', DOMExceptionName.InvalidStateError);
              }
            }
            buf.push("<?", n.target, " ", n.data, "?>");
            return null;
          case ENTITY_REFERENCE_NODE:
            if (requireWellFormed && !g.Name_exact.test(n.nodeName)) {
              throw new DOMException('The entity reference name "' + n.nodeName + '" is not a valid XML Name', DOMExceptionName.InvalidStateError);
            }
            buf.push("&", n.nodeName, ";");
            return null;
          default:
            buf.push("??", n.nodeName);
            return null;
        }
      },
      exit: function(n, childCtx) {
        if (childCtx && childCtx.tag) {
          buf.push("</", childCtx.tag, ">");
        }
      }
    });
  }
  function importNode(doc, node, deep) {
    var destRoot;
    walkDOM(node, null, {
      enter: function(srcNode, destParent) {
        var destNode = srcNode.cloneNode(false);
        destNode.ownerDocument = doc;
        destNode.parentNode = null;
        if (destParent === null) {
          destRoot = destNode;
        } else {
          destParent.appendChild(destNode);
        }
        var shouldDeep = srcNode.nodeType === ATTRIBUTE_NODE || deep;
        return shouldDeep ? destNode : null;
      }
    });
    return destRoot;
  }
  function cloneNode(doc, node, deep) {
    var destRoot;
    walkDOM(node, null, {
      enter: function(srcNode, destParent) {
        var destNode = new srcNode.constructor(PDC);
        for (var n in srcNode) {
          if (hasOwn(srcNode, n)) {
            var v = srcNode[n];
            if (typeof v != "object") {
              if (v != destNode[n]) {
                destNode[n] = v;
              }
            }
          }
        }
        if (srcNode.childNodes) {
          destNode.childNodes = new NodeList;
        }
        destNode.ownerDocument = doc;
        var shouldDeep = deep;
        switch (destNode.nodeType) {
          case ELEMENT_NODE:
            var attrs = srcNode.attributes;
            var attrs2 = destNode.attributes = new NamedNodeMap;
            var len = attrs.length;
            attrs2._ownerElement = destNode;
            for (var i = 0;i < len; i++) {
              destNode.setAttributeNode(cloneNode(doc, attrs.item(i), true));
            }
            break;
          case ATTRIBUTE_NODE:
            shouldDeep = true;
        }
        if (destParent !== null) {
          destParent.appendChild(destNode);
        } else {
          destRoot = destNode;
        }
        return shouldDeep ? destNode : null;
      }
    });
    return destRoot;
  }
  function __set__(object, key, value) {
    object[key] = value;
  }
  function childrenRefresh(node) {
    var ls = [];
    var child = node.firstChild;
    while (child) {
      if (child.nodeType === ELEMENT_NODE) {
        ls.push(child);
      }
      child = child.nextSibling;
    }
    return ls;
  }
  try {
    if (Object.defineProperty) {
      Object.defineProperty(LiveNodeList.prototype, "length", {
        get: function() {
          _updateLiveList(this);
          return this.$$length;
        }
      });
      Object.defineProperty(Node.prototype, "textContent", {
        get: function() {
          if (this.nodeType === ELEMENT_NODE || this.nodeType === DOCUMENT_FRAGMENT_NODE) {
            var buf = [];
            walkDOM(this, null, {
              enter: function(n) {
                if (n.nodeType === ELEMENT_NODE || n.nodeType === DOCUMENT_FRAGMENT_NODE) {
                  return true;
                }
                if (n.nodeType === PROCESSING_INSTRUCTION_NODE || n.nodeType === COMMENT_NODE) {
                  return null;
                }
                buf.push(n.nodeValue);
              }
            });
            return buf.join("");
          }
          return this.nodeValue;
        },
        set: function(data) {
          switch (this.nodeType) {
            case ELEMENT_NODE:
            case DOCUMENT_FRAGMENT_NODE:
              while (this.firstChild) {
                this.removeChild(this.firstChild);
              }
              if (data || String(data)) {
                this.appendChild(this.ownerDocument.createTextNode(data));
              }
              break;
            default:
              this.data = data;
              this.value = data;
              this.nodeValue = data;
          }
        }
      });
      Object.defineProperty(CharacterData.prototype, "data", {
        get: function() {
          return this._data != null ? this._data : "";
        },
        set: function(v) {
          this._data = v;
          this.length = typeof v === "string" ? v.length : 0;
        }
      });
      Object.defineProperty(CharacterData.prototype, "nodeValue", {
        get: function() {
          return this.data;
        },
        set: function(v) {
          this.data = v;
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(Element.prototype, "children", {
        get: function() {
          return new LiveNodeList(this, childrenRefresh);
        }
      });
      Object.defineProperty(Document.prototype, "children", {
        get: function() {
          return new LiveNodeList(this, childrenRefresh);
        }
      });
      Object.defineProperty(DocumentFragment.prototype, "children", {
        get: function() {
          return new LiveNodeList(this, childrenRefresh);
        }
      });
      __set__ = function(object, key, value) {
        object["$$" + key] = value;
      };
    }
  } catch (e) {}
  exports._updateLiveList = _updateLiveList;
  exports.Attr = Attr;
  exports.CDATASection = CDATASection;
  exports.CharacterData = CharacterData;
  exports.Comment = Comment;
  exports.Document = Document;
  exports.DocumentFragment = DocumentFragment;
  exports.DocumentType = DocumentType;
  exports.DOMImplementation = DOMImplementation;
  exports.Element = Element;
  exports.Entity = Entity;
  exports.EntityReference = EntityReference;
  exports.LiveNodeList = LiveNodeList;
  exports.NamedNodeMap = NamedNodeMap;
  exports.Node = Node;
  exports.NodeList = NodeList;
  exports.Notation = Notation;
  exports.Text = Text;
  exports.ProcessingInstruction = ProcessingInstruction;
  exports.walkDOM = walkDOM;
  exports.XMLSerializer = XMLSerializer;
});

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/@xmldom/xmldom/lib/entities.js
var require_entities = __commonJS(function(exports) {
  var freeze = require_conventions().freeze;
  exports.XML_ENTITIES = freeze({
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"'
  });
  exports.HTML_ENTITIES = freeze({
    Aacute: "Á",
    aacute: "á",
    Abreve: "Ă",
    abreve: "ă",
    ac: "∾",
    acd: "∿",
    acE: "∾̳",
    Acirc: "Â",
    acirc: "â",
    acute: "´",
    Acy: "А",
    acy: "а",
    AElig: "Æ",
    aelig: "æ",
    af: "⁡",
    Afr: "\uD835\uDD04",
    afr: "\uD835\uDD1E",
    Agrave: "À",
    agrave: "à",
    alefsym: "ℵ",
    aleph: "ℵ",
    Alpha: "Α",
    alpha: "α",
    Amacr: "Ā",
    amacr: "ā",
    amalg: "⨿",
    AMP: "&",
    amp: "&",
    And: "⩓",
    and: "∧",
    andand: "⩕",
    andd: "⩜",
    andslope: "⩘",
    andv: "⩚",
    ang: "∠",
    ange: "⦤",
    angle: "∠",
    angmsd: "∡",
    angmsdaa: "⦨",
    angmsdab: "⦩",
    angmsdac: "⦪",
    angmsdad: "⦫",
    angmsdae: "⦬",
    angmsdaf: "⦭",
    angmsdag: "⦮",
    angmsdah: "⦯",
    angrt: "∟",
    angrtvb: "⊾",
    angrtvbd: "⦝",
    angsph: "∢",
    angst: "Å",
    angzarr: "⍼",
    Aogon: "Ą",
    aogon: "ą",
    Aopf: "\uD835\uDD38",
    aopf: "\uD835\uDD52",
    ap: "≈",
    apacir: "⩯",
    apE: "⩰",
    ape: "≊",
    apid: "≋",
    apos: "'",
    ApplyFunction: "⁡",
    approx: "≈",
    approxeq: "≊",
    Aring: "Å",
    aring: "å",
    Ascr: "\uD835\uDC9C",
    ascr: "\uD835\uDCB6",
    Assign: "≔",
    ast: "*",
    asymp: "≈",
    asympeq: "≍",
    Atilde: "Ã",
    atilde: "ã",
    Auml: "Ä",
    auml: "ä",
    awconint: "∳",
    awint: "⨑",
    backcong: "≌",
    backepsilon: "϶",
    backprime: "‵",
    backsim: "∽",
    backsimeq: "⋍",
    Backslash: "∖",
    Barv: "⫧",
    barvee: "⊽",
    Barwed: "⌆",
    barwed: "⌅",
    barwedge: "⌅",
    bbrk: "⎵",
    bbrktbrk: "⎶",
    bcong: "≌",
    Bcy: "Б",
    bcy: "б",
    bdquo: "„",
    becaus: "∵",
    Because: "∵",
    because: "∵",
    bemptyv: "⦰",
    bepsi: "϶",
    bernou: "ℬ",
    Bernoullis: "ℬ",
    Beta: "Β",
    beta: "β",
    beth: "ℶ",
    between: "≬",
    Bfr: "\uD835\uDD05",
    bfr: "\uD835\uDD1F",
    bigcap: "⋂",
    bigcirc: "◯",
    bigcup: "⋃",
    bigodot: "⨀",
    bigoplus: "⨁",
    bigotimes: "⨂",
    bigsqcup: "⨆",
    bigstar: "★",
    bigtriangledown: "▽",
    bigtriangleup: "△",
    biguplus: "⨄",
    bigvee: "⋁",
    bigwedge: "⋀",
    bkarow: "⤍",
    blacklozenge: "⧫",
    blacksquare: "▪",
    blacktriangle: "▴",
    blacktriangledown: "▾",
    blacktriangleleft: "◂",
    blacktriangleright: "▸",
    blank: "␣",
    blk12: "▒",
    blk14: "░",
    blk34: "▓",
    block: "█",
    bne: "=⃥",
    bnequiv: "≡⃥",
    bNot: "⫭",
    bnot: "⌐",
    Bopf: "\uD835\uDD39",
    bopf: "\uD835\uDD53",
    bot: "⊥",
    bottom: "⊥",
    bowtie: "⋈",
    boxbox: "⧉",
    boxDL: "╗",
    boxDl: "╖",
    boxdL: "╕",
    boxdl: "┐",
    boxDR: "╔",
    boxDr: "╓",
    boxdR: "╒",
    boxdr: "┌",
    boxH: "═",
    boxh: "─",
    boxHD: "╦",
    boxHd: "╤",
    boxhD: "╥",
    boxhd: "┬",
    boxHU: "╩",
    boxHu: "╧",
    boxhU: "╨",
    boxhu: "┴",
    boxminus: "⊟",
    boxplus: "⊞",
    boxtimes: "⊠",
    boxUL: "╝",
    boxUl: "╜",
    boxuL: "╛",
    boxul: "┘",
    boxUR: "╚",
    boxUr: "╙",
    boxuR: "╘",
    boxur: "└",
    boxV: "║",
    boxv: "│",
    boxVH: "╬",
    boxVh: "╫",
    boxvH: "╪",
    boxvh: "┼",
    boxVL: "╣",
    boxVl: "╢",
    boxvL: "╡",
    boxvl: "┤",
    boxVR: "╠",
    boxVr: "╟",
    boxvR: "╞",
    boxvr: "├",
    bprime: "‵",
    Breve: "˘",
    breve: "˘",
    brvbar: "¦",
    Bscr: "ℬ",
    bscr: "\uD835\uDCB7",
    bsemi: "⁏",
    bsim: "∽",
    bsime: "⋍",
    bsol: "\\",
    bsolb: "⧅",
    bsolhsub: "⟈",
    bull: "•",
    bullet: "•",
    bump: "≎",
    bumpE: "⪮",
    bumpe: "≏",
    Bumpeq: "≎",
    bumpeq: "≏",
    Cacute: "Ć",
    cacute: "ć",
    Cap: "⋒",
    cap: "∩",
    capand: "⩄",
    capbrcup: "⩉",
    capcap: "⩋",
    capcup: "⩇",
    capdot: "⩀",
    CapitalDifferentialD: "ⅅ",
    caps: "∩︀",
    caret: "⁁",
    caron: "ˇ",
    Cayleys: "ℭ",
    ccaps: "⩍",
    Ccaron: "Č",
    ccaron: "č",
    Ccedil: "Ç",
    ccedil: "ç",
    Ccirc: "Ĉ",
    ccirc: "ĉ",
    Cconint: "∰",
    ccups: "⩌",
    ccupssm: "⩐",
    Cdot: "Ċ",
    cdot: "ċ",
    cedil: "¸",
    Cedilla: "¸",
    cemptyv: "⦲",
    cent: "¢",
    CenterDot: "·",
    centerdot: "·",
    Cfr: "ℭ",
    cfr: "\uD835\uDD20",
    CHcy: "Ч",
    chcy: "ч",
    check: "✓",
    checkmark: "✓",
    Chi: "Χ",
    chi: "χ",
    cir: "○",
    circ: "ˆ",
    circeq: "≗",
    circlearrowleft: "↺",
    circlearrowright: "↻",
    circledast: "⊛",
    circledcirc: "⊚",
    circleddash: "⊝",
    CircleDot: "⊙",
    circledR: "®",
    circledS: "Ⓢ",
    CircleMinus: "⊖",
    CirclePlus: "⊕",
    CircleTimes: "⊗",
    cirE: "⧃",
    cire: "≗",
    cirfnint: "⨐",
    cirmid: "⫯",
    cirscir: "⧂",
    ClockwiseContourIntegral: "∲",
    CloseCurlyDoubleQuote: "”",
    CloseCurlyQuote: "’",
    clubs: "♣",
    clubsuit: "♣",
    Colon: "∷",
    colon: ":",
    Colone: "⩴",
    colone: "≔",
    coloneq: "≔",
    comma: ",",
    commat: "@",
    comp: "∁",
    compfn: "∘",
    complement: "∁",
    complexes: "ℂ",
    cong: "≅",
    congdot: "⩭",
    Congruent: "≡",
    Conint: "∯",
    conint: "∮",
    ContourIntegral: "∮",
    Copf: "ℂ",
    copf: "\uD835\uDD54",
    coprod: "∐",
    Coproduct: "∐",
    COPY: "©",
    copy: "©",
    copysr: "℗",
    CounterClockwiseContourIntegral: "∳",
    crarr: "↵",
    Cross: "⨯",
    cross: "✗",
    Cscr: "\uD835\uDC9E",
    cscr: "\uD835\uDCB8",
    csub: "⫏",
    csube: "⫑",
    csup: "⫐",
    csupe: "⫒",
    ctdot: "⋯",
    cudarrl: "⤸",
    cudarrr: "⤵",
    cuepr: "⋞",
    cuesc: "⋟",
    cularr: "↶",
    cularrp: "⤽",
    Cup: "⋓",
    cup: "∪",
    cupbrcap: "⩈",
    CupCap: "≍",
    cupcap: "⩆",
    cupcup: "⩊",
    cupdot: "⊍",
    cupor: "⩅",
    cups: "∪︀",
    curarr: "↷",
    curarrm: "⤼",
    curlyeqprec: "⋞",
    curlyeqsucc: "⋟",
    curlyvee: "⋎",
    curlywedge: "⋏",
    curren: "¤",
    curvearrowleft: "↶",
    curvearrowright: "↷",
    cuvee: "⋎",
    cuwed: "⋏",
    cwconint: "∲",
    cwint: "∱",
    cylcty: "⌭",
    Dagger: "‡",
    dagger: "†",
    daleth: "ℸ",
    Darr: "↡",
    dArr: "⇓",
    darr: "↓",
    dash: "‐",
    Dashv: "⫤",
    dashv: "⊣",
    dbkarow: "⤏",
    dblac: "˝",
    Dcaron: "Ď",
    dcaron: "ď",
    Dcy: "Д",
    dcy: "д",
    DD: "ⅅ",
    dd: "ⅆ",
    ddagger: "‡",
    ddarr: "⇊",
    DDotrahd: "⤑",
    ddotseq: "⩷",
    deg: "°",
    Del: "∇",
    Delta: "Δ",
    delta: "δ",
    demptyv: "⦱",
    dfisht: "⥿",
    Dfr: "\uD835\uDD07",
    dfr: "\uD835\uDD21",
    dHar: "⥥",
    dharl: "⇃",
    dharr: "⇂",
    DiacriticalAcute: "´",
    DiacriticalDot: "˙",
    DiacriticalDoubleAcute: "˝",
    DiacriticalGrave: "`",
    DiacriticalTilde: "˜",
    diam: "⋄",
    Diamond: "⋄",
    diamond: "⋄",
    diamondsuit: "♦",
    diams: "♦",
    die: "¨",
    DifferentialD: "ⅆ",
    digamma: "ϝ",
    disin: "⋲",
    div: "÷",
    divide: "÷",
    divideontimes: "⋇",
    divonx: "⋇",
    DJcy: "Ђ",
    djcy: "ђ",
    dlcorn: "⌞",
    dlcrop: "⌍",
    dollar: "$",
    Dopf: "\uD835\uDD3B",
    dopf: "\uD835\uDD55",
    Dot: "¨",
    dot: "˙",
    DotDot: "⃜",
    doteq: "≐",
    doteqdot: "≑",
    DotEqual: "≐",
    dotminus: "∸",
    dotplus: "∔",
    dotsquare: "⊡",
    doublebarwedge: "⌆",
    DoubleContourIntegral: "∯",
    DoubleDot: "¨",
    DoubleDownArrow: "⇓",
    DoubleLeftArrow: "⇐",
    DoubleLeftRightArrow: "⇔",
    DoubleLeftTee: "⫤",
    DoubleLongLeftArrow: "⟸",
    DoubleLongLeftRightArrow: "⟺",
    DoubleLongRightArrow: "⟹",
    DoubleRightArrow: "⇒",
    DoubleRightTee: "⊨",
    DoubleUpArrow: "⇑",
    DoubleUpDownArrow: "⇕",
    DoubleVerticalBar: "∥",
    DownArrow: "↓",
    Downarrow: "⇓",
    downarrow: "↓",
    DownArrowBar: "⤓",
    DownArrowUpArrow: "⇵",
    DownBreve: "̑",
    downdownarrows: "⇊",
    downharpoonleft: "⇃",
    downharpoonright: "⇂",
    DownLeftRightVector: "⥐",
    DownLeftTeeVector: "⥞",
    DownLeftVector: "↽",
    DownLeftVectorBar: "⥖",
    DownRightTeeVector: "⥟",
    DownRightVector: "⇁",
    DownRightVectorBar: "⥗",
    DownTee: "⊤",
    DownTeeArrow: "↧",
    drbkarow: "⤐",
    drcorn: "⌟",
    drcrop: "⌌",
    Dscr: "\uD835\uDC9F",
    dscr: "\uD835\uDCB9",
    DScy: "Ѕ",
    dscy: "ѕ",
    dsol: "⧶",
    Dstrok: "Đ",
    dstrok: "đ",
    dtdot: "⋱",
    dtri: "▿",
    dtrif: "▾",
    duarr: "⇵",
    duhar: "⥯",
    dwangle: "⦦",
    DZcy: "Џ",
    dzcy: "џ",
    dzigrarr: "⟿",
    Eacute: "É",
    eacute: "é",
    easter: "⩮",
    Ecaron: "Ě",
    ecaron: "ě",
    ecir: "≖",
    Ecirc: "Ê",
    ecirc: "ê",
    ecolon: "≕",
    Ecy: "Э",
    ecy: "э",
    eDDot: "⩷",
    Edot: "Ė",
    eDot: "≑",
    edot: "ė",
    ee: "ⅇ",
    efDot: "≒",
    Efr: "\uD835\uDD08",
    efr: "\uD835\uDD22",
    eg: "⪚",
    Egrave: "È",
    egrave: "è",
    egs: "⪖",
    egsdot: "⪘",
    el: "⪙",
    Element: "∈",
    elinters: "⏧",
    ell: "ℓ",
    els: "⪕",
    elsdot: "⪗",
    Emacr: "Ē",
    emacr: "ē",
    empty: "∅",
    emptyset: "∅",
    EmptySmallSquare: "◻",
    emptyv: "∅",
    EmptyVerySmallSquare: "▫",
    emsp: " ",
    emsp13: " ",
    emsp14: " ",
    ENG: "Ŋ",
    eng: "ŋ",
    ensp: " ",
    Eogon: "Ę",
    eogon: "ę",
    Eopf: "\uD835\uDD3C",
    eopf: "\uD835\uDD56",
    epar: "⋕",
    eparsl: "⧣",
    eplus: "⩱",
    epsi: "ε",
    Epsilon: "Ε",
    epsilon: "ε",
    epsiv: "ϵ",
    eqcirc: "≖",
    eqcolon: "≕",
    eqsim: "≂",
    eqslantgtr: "⪖",
    eqslantless: "⪕",
    Equal: "⩵",
    equals: "=",
    EqualTilde: "≂",
    equest: "≟",
    Equilibrium: "⇌",
    equiv: "≡",
    equivDD: "⩸",
    eqvparsl: "⧥",
    erarr: "⥱",
    erDot: "≓",
    Escr: "ℰ",
    escr: "ℯ",
    esdot: "≐",
    Esim: "⩳",
    esim: "≂",
    Eta: "Η",
    eta: "η",
    ETH: "Ð",
    eth: "ð",
    Euml: "Ë",
    euml: "ë",
    euro: "€",
    excl: "!",
    exist: "∃",
    Exists: "∃",
    expectation: "ℰ",
    ExponentialE: "ⅇ",
    exponentiale: "ⅇ",
    fallingdotseq: "≒",
    Fcy: "Ф",
    fcy: "ф",
    female: "♀",
    ffilig: "ﬃ",
    fflig: "ﬀ",
    ffllig: "ﬄ",
    Ffr: "\uD835\uDD09",
    ffr: "\uD835\uDD23",
    filig: "ﬁ",
    FilledSmallSquare: "◼",
    FilledVerySmallSquare: "▪",
    fjlig: "fj",
    flat: "♭",
    fllig: "ﬂ",
    fltns: "▱",
    fnof: "ƒ",
    Fopf: "\uD835\uDD3D",
    fopf: "\uD835\uDD57",
    ForAll: "∀",
    forall: "∀",
    fork: "⋔",
    forkv: "⫙",
    Fouriertrf: "ℱ",
    fpartint: "⨍",
    frac12: "½",
    frac13: "⅓",
    frac14: "¼",
    frac15: "⅕",
    frac16: "⅙",
    frac18: "⅛",
    frac23: "⅔",
    frac25: "⅖",
    frac34: "¾",
    frac35: "⅗",
    frac38: "⅜",
    frac45: "⅘",
    frac56: "⅚",
    frac58: "⅝",
    frac78: "⅞",
    frasl: "⁄",
    frown: "⌢",
    Fscr: "ℱ",
    fscr: "\uD835\uDCBB",
    gacute: "ǵ",
    Gamma: "Γ",
    gamma: "γ",
    Gammad: "Ϝ",
    gammad: "ϝ",
    gap: "⪆",
    Gbreve: "Ğ",
    gbreve: "ğ",
    Gcedil: "Ģ",
    Gcirc: "Ĝ",
    gcirc: "ĝ",
    Gcy: "Г",
    gcy: "г",
    Gdot: "Ġ",
    gdot: "ġ",
    gE: "≧",
    ge: "≥",
    gEl: "⪌",
    gel: "⋛",
    geq: "≥",
    geqq: "≧",
    geqslant: "⩾",
    ges: "⩾",
    gescc: "⪩",
    gesdot: "⪀",
    gesdoto: "⪂",
    gesdotol: "⪄",
    gesl: "⋛︀",
    gesles: "⪔",
    Gfr: "\uD835\uDD0A",
    gfr: "\uD835\uDD24",
    Gg: "⋙",
    gg: "≫",
    ggg: "⋙",
    gimel: "ℷ",
    GJcy: "Ѓ",
    gjcy: "ѓ",
    gl: "≷",
    gla: "⪥",
    glE: "⪒",
    glj: "⪤",
    gnap: "⪊",
    gnapprox: "⪊",
    gnE: "≩",
    gne: "⪈",
    gneq: "⪈",
    gneqq: "≩",
    gnsim: "⋧",
    Gopf: "\uD835\uDD3E",
    gopf: "\uD835\uDD58",
    grave: "`",
    GreaterEqual: "≥",
    GreaterEqualLess: "⋛",
    GreaterFullEqual: "≧",
    GreaterGreater: "⪢",
    GreaterLess: "≷",
    GreaterSlantEqual: "⩾",
    GreaterTilde: "≳",
    Gscr: "\uD835\uDCA2",
    gscr: "ℊ",
    gsim: "≳",
    gsime: "⪎",
    gsiml: "⪐",
    Gt: "≫",
    GT: ">",
    gt: ">",
    gtcc: "⪧",
    gtcir: "⩺",
    gtdot: "⋗",
    gtlPar: "⦕",
    gtquest: "⩼",
    gtrapprox: "⪆",
    gtrarr: "⥸",
    gtrdot: "⋗",
    gtreqless: "⋛",
    gtreqqless: "⪌",
    gtrless: "≷",
    gtrsim: "≳",
    gvertneqq: "≩︀",
    gvnE: "≩︀",
    Hacek: "ˇ",
    hairsp: " ",
    half: "½",
    hamilt: "ℋ",
    HARDcy: "Ъ",
    hardcy: "ъ",
    hArr: "⇔",
    harr: "↔",
    harrcir: "⥈",
    harrw: "↭",
    Hat: "^",
    hbar: "ℏ",
    Hcirc: "Ĥ",
    hcirc: "ĥ",
    hearts: "♥",
    heartsuit: "♥",
    hellip: "…",
    hercon: "⊹",
    Hfr: "ℌ",
    hfr: "\uD835\uDD25",
    HilbertSpace: "ℋ",
    hksearow: "⤥",
    hkswarow: "⤦",
    hoarr: "⇿",
    homtht: "∻",
    hookleftarrow: "↩",
    hookrightarrow: "↪",
    Hopf: "ℍ",
    hopf: "\uD835\uDD59",
    horbar: "―",
    HorizontalLine: "─",
    Hscr: "ℋ",
    hscr: "\uD835\uDCBD",
    hslash: "ℏ",
    Hstrok: "Ħ",
    hstrok: "ħ",
    HumpDownHump: "≎",
    HumpEqual: "≏",
    hybull: "⁃",
    hyphen: "‐",
    Iacute: "Í",
    iacute: "í",
    ic: "⁣",
    Icirc: "Î",
    icirc: "î",
    Icy: "И",
    icy: "и",
    Idot: "İ",
    IEcy: "Е",
    iecy: "е",
    iexcl: "¡",
    iff: "⇔",
    Ifr: "ℑ",
    ifr: "\uD835\uDD26",
    Igrave: "Ì",
    igrave: "ì",
    ii: "ⅈ",
    iiiint: "⨌",
    iiint: "∭",
    iinfin: "⧜",
    iiota: "℩",
    IJlig: "Ĳ",
    ijlig: "ĳ",
    Im: "ℑ",
    Imacr: "Ī",
    imacr: "ī",
    image: "ℑ",
    ImaginaryI: "ⅈ",
    imagline: "ℐ",
    imagpart: "ℑ",
    imath: "ı",
    imof: "⊷",
    imped: "Ƶ",
    Implies: "⇒",
    in: "∈",
    incare: "℅",
    infin: "∞",
    infintie: "⧝",
    inodot: "ı",
    Int: "∬",
    int: "∫",
    intcal: "⊺",
    integers: "ℤ",
    Integral: "∫",
    intercal: "⊺",
    Intersection: "⋂",
    intlarhk: "⨗",
    intprod: "⨼",
    InvisibleComma: "⁣",
    InvisibleTimes: "⁢",
    IOcy: "Ё",
    iocy: "ё",
    Iogon: "Į",
    iogon: "į",
    Iopf: "\uD835\uDD40",
    iopf: "\uD835\uDD5A",
    Iota: "Ι",
    iota: "ι",
    iprod: "⨼",
    iquest: "¿",
    Iscr: "ℐ",
    iscr: "\uD835\uDCBE",
    isin: "∈",
    isindot: "⋵",
    isinE: "⋹",
    isins: "⋴",
    isinsv: "⋳",
    isinv: "∈",
    it: "⁢",
    Itilde: "Ĩ",
    itilde: "ĩ",
    Iukcy: "І",
    iukcy: "і",
    Iuml: "Ï",
    iuml: "ï",
    Jcirc: "Ĵ",
    jcirc: "ĵ",
    Jcy: "Й",
    jcy: "й",
    Jfr: "\uD835\uDD0D",
    jfr: "\uD835\uDD27",
    jmath: "ȷ",
    Jopf: "\uD835\uDD41",
    jopf: "\uD835\uDD5B",
    Jscr: "\uD835\uDCA5",
    jscr: "\uD835\uDCBF",
    Jsercy: "Ј",
    jsercy: "ј",
    Jukcy: "Є",
    jukcy: "є",
    Kappa: "Κ",
    kappa: "κ",
    kappav: "ϰ",
    Kcedil: "Ķ",
    kcedil: "ķ",
    Kcy: "К",
    kcy: "к",
    Kfr: "\uD835\uDD0E",
    kfr: "\uD835\uDD28",
    kgreen: "ĸ",
    KHcy: "Х",
    khcy: "х",
    KJcy: "Ќ",
    kjcy: "ќ",
    Kopf: "\uD835\uDD42",
    kopf: "\uD835\uDD5C",
    Kscr: "\uD835\uDCA6",
    kscr: "\uD835\uDCC0",
    lAarr: "⇚",
    Lacute: "Ĺ",
    lacute: "ĺ",
    laemptyv: "⦴",
    lagran: "ℒ",
    Lambda: "Λ",
    lambda: "λ",
    Lang: "⟪",
    lang: "⟨",
    langd: "⦑",
    langle: "⟨",
    lap: "⪅",
    Laplacetrf: "ℒ",
    laquo: "«",
    Larr: "↞",
    lArr: "⇐",
    larr: "←",
    larrb: "⇤",
    larrbfs: "⤟",
    larrfs: "⤝",
    larrhk: "↩",
    larrlp: "↫",
    larrpl: "⤹",
    larrsim: "⥳",
    larrtl: "↢",
    lat: "⪫",
    lAtail: "⤛",
    latail: "⤙",
    late: "⪭",
    lates: "⪭︀",
    lBarr: "⤎",
    lbarr: "⤌",
    lbbrk: "❲",
    lbrace: "{",
    lbrack: "[",
    lbrke: "⦋",
    lbrksld: "⦏",
    lbrkslu: "⦍",
    Lcaron: "Ľ",
    lcaron: "ľ",
    Lcedil: "Ļ",
    lcedil: "ļ",
    lceil: "⌈",
    lcub: "{",
    Lcy: "Л",
    lcy: "л",
    ldca: "⤶",
    ldquo: "“",
    ldquor: "„",
    ldrdhar: "⥧",
    ldrushar: "⥋",
    ldsh: "↲",
    lE: "≦",
    le: "≤",
    LeftAngleBracket: "⟨",
    LeftArrow: "←",
    Leftarrow: "⇐",
    leftarrow: "←",
    LeftArrowBar: "⇤",
    LeftArrowRightArrow: "⇆",
    leftarrowtail: "↢",
    LeftCeiling: "⌈",
    LeftDoubleBracket: "⟦",
    LeftDownTeeVector: "⥡",
    LeftDownVector: "⇃",
    LeftDownVectorBar: "⥙",
    LeftFloor: "⌊",
    leftharpoondown: "↽",
    leftharpoonup: "↼",
    leftleftarrows: "⇇",
    LeftRightArrow: "↔",
    Leftrightarrow: "⇔",
    leftrightarrow: "↔",
    leftrightarrows: "⇆",
    leftrightharpoons: "⇋",
    leftrightsquigarrow: "↭",
    LeftRightVector: "⥎",
    LeftTee: "⊣",
    LeftTeeArrow: "↤",
    LeftTeeVector: "⥚",
    leftthreetimes: "⋋",
    LeftTriangle: "⊲",
    LeftTriangleBar: "⧏",
    LeftTriangleEqual: "⊴",
    LeftUpDownVector: "⥑",
    LeftUpTeeVector: "⥠",
    LeftUpVector: "↿",
    LeftUpVectorBar: "⥘",
    LeftVector: "↼",
    LeftVectorBar: "⥒",
    lEg: "⪋",
    leg: "⋚",
    leq: "≤",
    leqq: "≦",
    leqslant: "⩽",
    les: "⩽",
    lescc: "⪨",
    lesdot: "⩿",
    lesdoto: "⪁",
    lesdotor: "⪃",
    lesg: "⋚︀",
    lesges: "⪓",
    lessapprox: "⪅",
    lessdot: "⋖",
    lesseqgtr: "⋚",
    lesseqqgtr: "⪋",
    LessEqualGreater: "⋚",
    LessFullEqual: "≦",
    LessGreater: "≶",
    lessgtr: "≶",
    LessLess: "⪡",
    lesssim: "≲",
    LessSlantEqual: "⩽",
    LessTilde: "≲",
    lfisht: "⥼",
    lfloor: "⌊",
    Lfr: "\uD835\uDD0F",
    lfr: "\uD835\uDD29",
    lg: "≶",
    lgE: "⪑",
    lHar: "⥢",
    lhard: "↽",
    lharu: "↼",
    lharul: "⥪",
    lhblk: "▄",
    LJcy: "Љ",
    ljcy: "љ",
    Ll: "⋘",
    ll: "≪",
    llarr: "⇇",
    llcorner: "⌞",
    Lleftarrow: "⇚",
    llhard: "⥫",
    lltri: "◺",
    Lmidot: "Ŀ",
    lmidot: "ŀ",
    lmoust: "⎰",
    lmoustache: "⎰",
    lnap: "⪉",
    lnapprox: "⪉",
    lnE: "≨",
    lne: "⪇",
    lneq: "⪇",
    lneqq: "≨",
    lnsim: "⋦",
    loang: "⟬",
    loarr: "⇽",
    lobrk: "⟦",
    LongLeftArrow: "⟵",
    Longleftarrow: "⟸",
    longleftarrow: "⟵",
    LongLeftRightArrow: "⟷",
    Longleftrightarrow: "⟺",
    longleftrightarrow: "⟷",
    longmapsto: "⟼",
    LongRightArrow: "⟶",
    Longrightarrow: "⟹",
    longrightarrow: "⟶",
    looparrowleft: "↫",
    looparrowright: "↬",
    lopar: "⦅",
    Lopf: "\uD835\uDD43",
    lopf: "\uD835\uDD5D",
    loplus: "⨭",
    lotimes: "⨴",
    lowast: "∗",
    lowbar: "_",
    LowerLeftArrow: "↙",
    LowerRightArrow: "↘",
    loz: "◊",
    lozenge: "◊",
    lozf: "⧫",
    lpar: "(",
    lparlt: "⦓",
    lrarr: "⇆",
    lrcorner: "⌟",
    lrhar: "⇋",
    lrhard: "⥭",
    lrm: "‎",
    lrtri: "⊿",
    lsaquo: "‹",
    Lscr: "ℒ",
    lscr: "\uD835\uDCC1",
    Lsh: "↰",
    lsh: "↰",
    lsim: "≲",
    lsime: "⪍",
    lsimg: "⪏",
    lsqb: "[",
    lsquo: "‘",
    lsquor: "‚",
    Lstrok: "Ł",
    lstrok: "ł",
    Lt: "≪",
    LT: "<",
    lt: "<",
    ltcc: "⪦",
    ltcir: "⩹",
    ltdot: "⋖",
    lthree: "⋋",
    ltimes: "⋉",
    ltlarr: "⥶",
    ltquest: "⩻",
    ltri: "◃",
    ltrie: "⊴",
    ltrif: "◂",
    ltrPar: "⦖",
    lurdshar: "⥊",
    luruhar: "⥦",
    lvertneqq: "≨︀",
    lvnE: "≨︀",
    macr: "¯",
    male: "♂",
    malt: "✠",
    maltese: "✠",
    Map: "⤅",
    map: "↦",
    mapsto: "↦",
    mapstodown: "↧",
    mapstoleft: "↤",
    mapstoup: "↥",
    marker: "▮",
    mcomma: "⨩",
    Mcy: "М",
    mcy: "м",
    mdash: "—",
    mDDot: "∺",
    measuredangle: "∡",
    MediumSpace: " ",
    Mellintrf: "ℳ",
    Mfr: "\uD835\uDD10",
    mfr: "\uD835\uDD2A",
    mho: "℧",
    micro: "µ",
    mid: "∣",
    midast: "*",
    midcir: "⫰",
    middot: "·",
    minus: "−",
    minusb: "⊟",
    minusd: "∸",
    minusdu: "⨪",
    MinusPlus: "∓",
    mlcp: "⫛",
    mldr: "…",
    mnplus: "∓",
    models: "⊧",
    Mopf: "\uD835\uDD44",
    mopf: "\uD835\uDD5E",
    mp: "∓",
    Mscr: "ℳ",
    mscr: "\uD835\uDCC2",
    mstpos: "∾",
    Mu: "Μ",
    mu: "μ",
    multimap: "⊸",
    mumap: "⊸",
    nabla: "∇",
    Nacute: "Ń",
    nacute: "ń",
    nang: "∠⃒",
    nap: "≉",
    napE: "⩰̸",
    napid: "≋̸",
    napos: "ŉ",
    napprox: "≉",
    natur: "♮",
    natural: "♮",
    naturals: "ℕ",
    nbsp: " ",
    nbump: "≎̸",
    nbumpe: "≏̸",
    ncap: "⩃",
    Ncaron: "Ň",
    ncaron: "ň",
    Ncedil: "Ņ",
    ncedil: "ņ",
    ncong: "≇",
    ncongdot: "⩭̸",
    ncup: "⩂",
    Ncy: "Н",
    ncy: "н",
    ndash: "–",
    ne: "≠",
    nearhk: "⤤",
    neArr: "⇗",
    nearr: "↗",
    nearrow: "↗",
    nedot: "≐̸",
    NegativeMediumSpace: "​",
    NegativeThickSpace: "​",
    NegativeThinSpace: "​",
    NegativeVeryThinSpace: "​",
    nequiv: "≢",
    nesear: "⤨",
    nesim: "≂̸",
    NestedGreaterGreater: "≫",
    NestedLessLess: "≪",
    NewLine: `
`,
    nexist: "∄",
    nexists: "∄",
    Nfr: "\uD835\uDD11",
    nfr: "\uD835\uDD2B",
    ngE: "≧̸",
    nge: "≱",
    ngeq: "≱",
    ngeqq: "≧̸",
    ngeqslant: "⩾̸",
    nges: "⩾̸",
    nGg: "⋙̸",
    ngsim: "≵",
    nGt: "≫⃒",
    ngt: "≯",
    ngtr: "≯",
    nGtv: "≫̸",
    nhArr: "⇎",
    nharr: "↮",
    nhpar: "⫲",
    ni: "∋",
    nis: "⋼",
    nisd: "⋺",
    niv: "∋",
    NJcy: "Њ",
    njcy: "њ",
    nlArr: "⇍",
    nlarr: "↚",
    nldr: "‥",
    nlE: "≦̸",
    nle: "≰",
    nLeftarrow: "⇍",
    nleftarrow: "↚",
    nLeftrightarrow: "⇎",
    nleftrightarrow: "↮",
    nleq: "≰",
    nleqq: "≦̸",
    nleqslant: "⩽̸",
    nles: "⩽̸",
    nless: "≮",
    nLl: "⋘̸",
    nlsim: "≴",
    nLt: "≪⃒",
    nlt: "≮",
    nltri: "⋪",
    nltrie: "⋬",
    nLtv: "≪̸",
    nmid: "∤",
    NoBreak: "⁠",
    NonBreakingSpace: " ",
    Nopf: "ℕ",
    nopf: "\uD835\uDD5F",
    Not: "⫬",
    not: "¬",
    NotCongruent: "≢",
    NotCupCap: "≭",
    NotDoubleVerticalBar: "∦",
    NotElement: "∉",
    NotEqual: "≠",
    NotEqualTilde: "≂̸",
    NotExists: "∄",
    NotGreater: "≯",
    NotGreaterEqual: "≱",
    NotGreaterFullEqual: "≧̸",
    NotGreaterGreater: "≫̸",
    NotGreaterLess: "≹",
    NotGreaterSlantEqual: "⩾̸",
    NotGreaterTilde: "≵",
    NotHumpDownHump: "≎̸",
    NotHumpEqual: "≏̸",
    notin: "∉",
    notindot: "⋵̸",
    notinE: "⋹̸",
    notinva: "∉",
    notinvb: "⋷",
    notinvc: "⋶",
    NotLeftTriangle: "⋪",
    NotLeftTriangleBar: "⧏̸",
    NotLeftTriangleEqual: "⋬",
    NotLess: "≮",
    NotLessEqual: "≰",
    NotLessGreater: "≸",
    NotLessLess: "≪̸",
    NotLessSlantEqual: "⩽̸",
    NotLessTilde: "≴",
    NotNestedGreaterGreater: "⪢̸",
    NotNestedLessLess: "⪡̸",
    notni: "∌",
    notniva: "∌",
    notnivb: "⋾",
    notnivc: "⋽",
    NotPrecedes: "⊀",
    NotPrecedesEqual: "⪯̸",
    NotPrecedesSlantEqual: "⋠",
    NotReverseElement: "∌",
    NotRightTriangle: "⋫",
    NotRightTriangleBar: "⧐̸",
    NotRightTriangleEqual: "⋭",
    NotSquareSubset: "⊏̸",
    NotSquareSubsetEqual: "⋢",
    NotSquareSuperset: "⊐̸",
    NotSquareSupersetEqual: "⋣",
    NotSubset: "⊂⃒",
    NotSubsetEqual: "⊈",
    NotSucceeds: "⊁",
    NotSucceedsEqual: "⪰̸",
    NotSucceedsSlantEqual: "⋡",
    NotSucceedsTilde: "≿̸",
    NotSuperset: "⊃⃒",
    NotSupersetEqual: "⊉",
    NotTilde: "≁",
    NotTildeEqual: "≄",
    NotTildeFullEqual: "≇",
    NotTildeTilde: "≉",
    NotVerticalBar: "∤",
    npar: "∦",
    nparallel: "∦",
    nparsl: "⫽⃥",
    npart: "∂̸",
    npolint: "⨔",
    npr: "⊀",
    nprcue: "⋠",
    npre: "⪯̸",
    nprec: "⊀",
    npreceq: "⪯̸",
    nrArr: "⇏",
    nrarr: "↛",
    nrarrc: "⤳̸",
    nrarrw: "↝̸",
    nRightarrow: "⇏",
    nrightarrow: "↛",
    nrtri: "⋫",
    nrtrie: "⋭",
    nsc: "⊁",
    nsccue: "⋡",
    nsce: "⪰̸",
    Nscr: "\uD835\uDCA9",
    nscr: "\uD835\uDCC3",
    nshortmid: "∤",
    nshortparallel: "∦",
    nsim: "≁",
    nsime: "≄",
    nsimeq: "≄",
    nsmid: "∤",
    nspar: "∦",
    nsqsube: "⋢",
    nsqsupe: "⋣",
    nsub: "⊄",
    nsubE: "⫅̸",
    nsube: "⊈",
    nsubset: "⊂⃒",
    nsubseteq: "⊈",
    nsubseteqq: "⫅̸",
    nsucc: "⊁",
    nsucceq: "⪰̸",
    nsup: "⊅",
    nsupE: "⫆̸",
    nsupe: "⊉",
    nsupset: "⊃⃒",
    nsupseteq: "⊉",
    nsupseteqq: "⫆̸",
    ntgl: "≹",
    Ntilde: "Ñ",
    ntilde: "ñ",
    ntlg: "≸",
    ntriangleleft: "⋪",
    ntrianglelefteq: "⋬",
    ntriangleright: "⋫",
    ntrianglerighteq: "⋭",
    Nu: "Ν",
    nu: "ν",
    num: "#",
    numero: "№",
    numsp: " ",
    nvap: "≍⃒",
    nVDash: "⊯",
    nVdash: "⊮",
    nvDash: "⊭",
    nvdash: "⊬",
    nvge: "≥⃒",
    nvgt: ">⃒",
    nvHarr: "⤄",
    nvinfin: "⧞",
    nvlArr: "⤂",
    nvle: "≤⃒",
    nvlt: "<⃒",
    nvltrie: "⊴⃒",
    nvrArr: "⤃",
    nvrtrie: "⊵⃒",
    nvsim: "∼⃒",
    nwarhk: "⤣",
    nwArr: "⇖",
    nwarr: "↖",
    nwarrow: "↖",
    nwnear: "⤧",
    Oacute: "Ó",
    oacute: "ó",
    oast: "⊛",
    ocir: "⊚",
    Ocirc: "Ô",
    ocirc: "ô",
    Ocy: "О",
    ocy: "о",
    odash: "⊝",
    Odblac: "Ő",
    odblac: "ő",
    odiv: "⨸",
    odot: "⊙",
    odsold: "⦼",
    OElig: "Œ",
    oelig: "œ",
    ofcir: "⦿",
    Ofr: "\uD835\uDD12",
    ofr: "\uD835\uDD2C",
    ogon: "˛",
    Ograve: "Ò",
    ograve: "ò",
    ogt: "⧁",
    ohbar: "⦵",
    ohm: "Ω",
    oint: "∮",
    olarr: "↺",
    olcir: "⦾",
    olcross: "⦻",
    oline: "‾",
    olt: "⧀",
    Omacr: "Ō",
    omacr: "ō",
    Omega: "Ω",
    omega: "ω",
    Omicron: "Ο",
    omicron: "ο",
    omid: "⦶",
    ominus: "⊖",
    Oopf: "\uD835\uDD46",
    oopf: "\uD835\uDD60",
    opar: "⦷",
    OpenCurlyDoubleQuote: "“",
    OpenCurlyQuote: "‘",
    operp: "⦹",
    oplus: "⊕",
    Or: "⩔",
    or: "∨",
    orarr: "↻",
    ord: "⩝",
    order: "ℴ",
    orderof: "ℴ",
    ordf: "ª",
    ordm: "º",
    origof: "⊶",
    oror: "⩖",
    orslope: "⩗",
    orv: "⩛",
    oS: "Ⓢ",
    Oscr: "\uD835\uDCAA",
    oscr: "ℴ",
    Oslash: "Ø",
    oslash: "ø",
    osol: "⊘",
    Otilde: "Õ",
    otilde: "õ",
    Otimes: "⨷",
    otimes: "⊗",
    otimesas: "⨶",
    Ouml: "Ö",
    ouml: "ö",
    ovbar: "⌽",
    OverBar: "‾",
    OverBrace: "⏞",
    OverBracket: "⎴",
    OverParenthesis: "⏜",
    par: "∥",
    para: "¶",
    parallel: "∥",
    parsim: "⫳",
    parsl: "⫽",
    part: "∂",
    PartialD: "∂",
    Pcy: "П",
    pcy: "п",
    percnt: "%",
    period: ".",
    permil: "‰",
    perp: "⊥",
    pertenk: "‱",
    Pfr: "\uD835\uDD13",
    pfr: "\uD835\uDD2D",
    Phi: "Φ",
    phi: "φ",
    phiv: "ϕ",
    phmmat: "ℳ",
    phone: "☎",
    Pi: "Π",
    pi: "π",
    pitchfork: "⋔",
    piv: "ϖ",
    planck: "ℏ",
    planckh: "ℎ",
    plankv: "ℏ",
    plus: "+",
    plusacir: "⨣",
    plusb: "⊞",
    pluscir: "⨢",
    plusdo: "∔",
    plusdu: "⨥",
    pluse: "⩲",
    PlusMinus: "±",
    plusmn: "±",
    plussim: "⨦",
    plustwo: "⨧",
    pm: "±",
    Poincareplane: "ℌ",
    pointint: "⨕",
    Popf: "ℙ",
    popf: "\uD835\uDD61",
    pound: "£",
    Pr: "⪻",
    pr: "≺",
    prap: "⪷",
    prcue: "≼",
    prE: "⪳",
    pre: "⪯",
    prec: "≺",
    precapprox: "⪷",
    preccurlyeq: "≼",
    Precedes: "≺",
    PrecedesEqual: "⪯",
    PrecedesSlantEqual: "≼",
    PrecedesTilde: "≾",
    preceq: "⪯",
    precnapprox: "⪹",
    precneqq: "⪵",
    precnsim: "⋨",
    precsim: "≾",
    Prime: "″",
    prime: "′",
    primes: "ℙ",
    prnap: "⪹",
    prnE: "⪵",
    prnsim: "⋨",
    prod: "∏",
    Product: "∏",
    profalar: "⌮",
    profline: "⌒",
    profsurf: "⌓",
    prop: "∝",
    Proportion: "∷",
    Proportional: "∝",
    propto: "∝",
    prsim: "≾",
    prurel: "⊰",
    Pscr: "\uD835\uDCAB",
    pscr: "\uD835\uDCC5",
    Psi: "Ψ",
    psi: "ψ",
    puncsp: " ",
    Qfr: "\uD835\uDD14",
    qfr: "\uD835\uDD2E",
    qint: "⨌",
    Qopf: "ℚ",
    qopf: "\uD835\uDD62",
    qprime: "⁗",
    Qscr: "\uD835\uDCAC",
    qscr: "\uD835\uDCC6",
    quaternions: "ℍ",
    quatint: "⨖",
    quest: "?",
    questeq: "≟",
    QUOT: '"',
    quot: '"',
    rAarr: "⇛",
    race: "∽̱",
    Racute: "Ŕ",
    racute: "ŕ",
    radic: "√",
    raemptyv: "⦳",
    Rang: "⟫",
    rang: "⟩",
    rangd: "⦒",
    range: "⦥",
    rangle: "⟩",
    raquo: "»",
    Rarr: "↠",
    rArr: "⇒",
    rarr: "→",
    rarrap: "⥵",
    rarrb: "⇥",
    rarrbfs: "⤠",
    rarrc: "⤳",
    rarrfs: "⤞",
    rarrhk: "↪",
    rarrlp: "↬",
    rarrpl: "⥅",
    rarrsim: "⥴",
    Rarrtl: "⤖",
    rarrtl: "↣",
    rarrw: "↝",
    rAtail: "⤜",
    ratail: "⤚",
    ratio: "∶",
    rationals: "ℚ",
    RBarr: "⤐",
    rBarr: "⤏",
    rbarr: "⤍",
    rbbrk: "❳",
    rbrace: "}",
    rbrack: "]",
    rbrke: "⦌",
    rbrksld: "⦎",
    rbrkslu: "⦐",
    Rcaron: "Ř",
    rcaron: "ř",
    Rcedil: "Ŗ",
    rcedil: "ŗ",
    rceil: "⌉",
    rcub: "}",
    Rcy: "Р",
    rcy: "р",
    rdca: "⤷",
    rdldhar: "⥩",
    rdquo: "”",
    rdquor: "”",
    rdsh: "↳",
    Re: "ℜ",
    real: "ℜ",
    realine: "ℛ",
    realpart: "ℜ",
    reals: "ℝ",
    rect: "▭",
    REG: "®",
    reg: "®",
    ReverseElement: "∋",
    ReverseEquilibrium: "⇋",
    ReverseUpEquilibrium: "⥯",
    rfisht: "⥽",
    rfloor: "⌋",
    Rfr: "ℜ",
    rfr: "\uD835\uDD2F",
    rHar: "⥤",
    rhard: "⇁",
    rharu: "⇀",
    rharul: "⥬",
    Rho: "Ρ",
    rho: "ρ",
    rhov: "ϱ",
    RightAngleBracket: "⟩",
    RightArrow: "→",
    Rightarrow: "⇒",
    rightarrow: "→",
    RightArrowBar: "⇥",
    RightArrowLeftArrow: "⇄",
    rightarrowtail: "↣",
    RightCeiling: "⌉",
    RightDoubleBracket: "⟧",
    RightDownTeeVector: "⥝",
    RightDownVector: "⇂",
    RightDownVectorBar: "⥕",
    RightFloor: "⌋",
    rightharpoondown: "⇁",
    rightharpoonup: "⇀",
    rightleftarrows: "⇄",
    rightleftharpoons: "⇌",
    rightrightarrows: "⇉",
    rightsquigarrow: "↝",
    RightTee: "⊢",
    RightTeeArrow: "↦",
    RightTeeVector: "⥛",
    rightthreetimes: "⋌",
    RightTriangle: "⊳",
    RightTriangleBar: "⧐",
    RightTriangleEqual: "⊵",
    RightUpDownVector: "⥏",
    RightUpTeeVector: "⥜",
    RightUpVector: "↾",
    RightUpVectorBar: "⥔",
    RightVector: "⇀",
    RightVectorBar: "⥓",
    ring: "˚",
    risingdotseq: "≓",
    rlarr: "⇄",
    rlhar: "⇌",
    rlm: "‏",
    rmoust: "⎱",
    rmoustache: "⎱",
    rnmid: "⫮",
    roang: "⟭",
    roarr: "⇾",
    robrk: "⟧",
    ropar: "⦆",
    Ropf: "ℝ",
    ropf: "\uD835\uDD63",
    roplus: "⨮",
    rotimes: "⨵",
    RoundImplies: "⥰",
    rpar: ")",
    rpargt: "⦔",
    rppolint: "⨒",
    rrarr: "⇉",
    Rrightarrow: "⇛",
    rsaquo: "›",
    Rscr: "ℛ",
    rscr: "\uD835\uDCC7",
    Rsh: "↱",
    rsh: "↱",
    rsqb: "]",
    rsquo: "’",
    rsquor: "’",
    rthree: "⋌",
    rtimes: "⋊",
    rtri: "▹",
    rtrie: "⊵",
    rtrif: "▸",
    rtriltri: "⧎",
    RuleDelayed: "⧴",
    ruluhar: "⥨",
    rx: "℞",
    Sacute: "Ś",
    sacute: "ś",
    sbquo: "‚",
    Sc: "⪼",
    sc: "≻",
    scap: "⪸",
    Scaron: "Š",
    scaron: "š",
    sccue: "≽",
    scE: "⪴",
    sce: "⪰",
    Scedil: "Ş",
    scedil: "ş",
    Scirc: "Ŝ",
    scirc: "ŝ",
    scnap: "⪺",
    scnE: "⪶",
    scnsim: "⋩",
    scpolint: "⨓",
    scsim: "≿",
    Scy: "С",
    scy: "с",
    sdot: "⋅",
    sdotb: "⊡",
    sdote: "⩦",
    searhk: "⤥",
    seArr: "⇘",
    searr: "↘",
    searrow: "↘",
    sect: "§",
    semi: ";",
    seswar: "⤩",
    setminus: "∖",
    setmn: "∖",
    sext: "✶",
    Sfr: "\uD835\uDD16",
    sfr: "\uD835\uDD30",
    sfrown: "⌢",
    sharp: "♯",
    SHCHcy: "Щ",
    shchcy: "щ",
    SHcy: "Ш",
    shcy: "ш",
    ShortDownArrow: "↓",
    ShortLeftArrow: "←",
    shortmid: "∣",
    shortparallel: "∥",
    ShortRightArrow: "→",
    ShortUpArrow: "↑",
    shy: "­",
    Sigma: "Σ",
    sigma: "σ",
    sigmaf: "ς",
    sigmav: "ς",
    sim: "∼",
    simdot: "⩪",
    sime: "≃",
    simeq: "≃",
    simg: "⪞",
    simgE: "⪠",
    siml: "⪝",
    simlE: "⪟",
    simne: "≆",
    simplus: "⨤",
    simrarr: "⥲",
    slarr: "←",
    SmallCircle: "∘",
    smallsetminus: "∖",
    smashp: "⨳",
    smeparsl: "⧤",
    smid: "∣",
    smile: "⌣",
    smt: "⪪",
    smte: "⪬",
    smtes: "⪬︀",
    SOFTcy: "Ь",
    softcy: "ь",
    sol: "/",
    solb: "⧄",
    solbar: "⌿",
    Sopf: "\uD835\uDD4A",
    sopf: "\uD835\uDD64",
    spades: "♠",
    spadesuit: "♠",
    spar: "∥",
    sqcap: "⊓",
    sqcaps: "⊓︀",
    sqcup: "⊔",
    sqcups: "⊔︀",
    Sqrt: "√",
    sqsub: "⊏",
    sqsube: "⊑",
    sqsubset: "⊏",
    sqsubseteq: "⊑",
    sqsup: "⊐",
    sqsupe: "⊒",
    sqsupset: "⊐",
    sqsupseteq: "⊒",
    squ: "□",
    Square: "□",
    square: "□",
    SquareIntersection: "⊓",
    SquareSubset: "⊏",
    SquareSubsetEqual: "⊑",
    SquareSuperset: "⊐",
    SquareSupersetEqual: "⊒",
    SquareUnion: "⊔",
    squarf: "▪",
    squf: "▪",
    srarr: "→",
    Sscr: "\uD835\uDCAE",
    sscr: "\uD835\uDCC8",
    ssetmn: "∖",
    ssmile: "⌣",
    sstarf: "⋆",
    Star: "⋆",
    star: "☆",
    starf: "★",
    straightepsilon: "ϵ",
    straightphi: "ϕ",
    strns: "¯",
    Sub: "⋐",
    sub: "⊂",
    subdot: "⪽",
    subE: "⫅",
    sube: "⊆",
    subedot: "⫃",
    submult: "⫁",
    subnE: "⫋",
    subne: "⊊",
    subplus: "⪿",
    subrarr: "⥹",
    Subset: "⋐",
    subset: "⊂",
    subseteq: "⊆",
    subseteqq: "⫅",
    SubsetEqual: "⊆",
    subsetneq: "⊊",
    subsetneqq: "⫋",
    subsim: "⫇",
    subsub: "⫕",
    subsup: "⫓",
    succ: "≻",
    succapprox: "⪸",
    succcurlyeq: "≽",
    Succeeds: "≻",
    SucceedsEqual: "⪰",
    SucceedsSlantEqual: "≽",
    SucceedsTilde: "≿",
    succeq: "⪰",
    succnapprox: "⪺",
    succneqq: "⪶",
    succnsim: "⋩",
    succsim: "≿",
    SuchThat: "∋",
    Sum: "∑",
    sum: "∑",
    sung: "♪",
    Sup: "⋑",
    sup: "⊃",
    sup1: "¹",
    sup2: "²",
    sup3: "³",
    supdot: "⪾",
    supdsub: "⫘",
    supE: "⫆",
    supe: "⊇",
    supedot: "⫄",
    Superset: "⊃",
    SupersetEqual: "⊇",
    suphsol: "⟉",
    suphsub: "⫗",
    suplarr: "⥻",
    supmult: "⫂",
    supnE: "⫌",
    supne: "⊋",
    supplus: "⫀",
    Supset: "⋑",
    supset: "⊃",
    supseteq: "⊇",
    supseteqq: "⫆",
    supsetneq: "⊋",
    supsetneqq: "⫌",
    supsim: "⫈",
    supsub: "⫔",
    supsup: "⫖",
    swarhk: "⤦",
    swArr: "⇙",
    swarr: "↙",
    swarrow: "↙",
    swnwar: "⤪",
    szlig: "ß",
    Tab: "\t",
    target: "⌖",
    Tau: "Τ",
    tau: "τ",
    tbrk: "⎴",
    Tcaron: "Ť",
    tcaron: "ť",
    Tcedil: "Ţ",
    tcedil: "ţ",
    Tcy: "Т",
    tcy: "т",
    tdot: "⃛",
    telrec: "⌕",
    Tfr: "\uD835\uDD17",
    tfr: "\uD835\uDD31",
    there4: "∴",
    Therefore: "∴",
    therefore: "∴",
    Theta: "Θ",
    theta: "θ",
    thetasym: "ϑ",
    thetav: "ϑ",
    thickapprox: "≈",
    thicksim: "∼",
    ThickSpace: "  ",
    thinsp: " ",
    ThinSpace: " ",
    thkap: "≈",
    thksim: "∼",
    THORN: "Þ",
    thorn: "þ",
    Tilde: "∼",
    tilde: "˜",
    TildeEqual: "≃",
    TildeFullEqual: "≅",
    TildeTilde: "≈",
    times: "×",
    timesb: "⊠",
    timesbar: "⨱",
    timesd: "⨰",
    tint: "∭",
    toea: "⤨",
    top: "⊤",
    topbot: "⌶",
    topcir: "⫱",
    Topf: "\uD835\uDD4B",
    topf: "\uD835\uDD65",
    topfork: "⫚",
    tosa: "⤩",
    tprime: "‴",
    TRADE: "™",
    trade: "™",
    triangle: "▵",
    triangledown: "▿",
    triangleleft: "◃",
    trianglelefteq: "⊴",
    triangleq: "≜",
    triangleright: "▹",
    trianglerighteq: "⊵",
    tridot: "◬",
    trie: "≜",
    triminus: "⨺",
    TripleDot: "⃛",
    triplus: "⨹",
    trisb: "⧍",
    tritime: "⨻",
    trpezium: "⏢",
    Tscr: "\uD835\uDCAF",
    tscr: "\uD835\uDCC9",
    TScy: "Ц",
    tscy: "ц",
    TSHcy: "Ћ",
    tshcy: "ћ",
    Tstrok: "Ŧ",
    tstrok: "ŧ",
    twixt: "≬",
    twoheadleftarrow: "↞",
    twoheadrightarrow: "↠",
    Uacute: "Ú",
    uacute: "ú",
    Uarr: "↟",
    uArr: "⇑",
    uarr: "↑",
    Uarrocir: "⥉",
    Ubrcy: "Ў",
    ubrcy: "ў",
    Ubreve: "Ŭ",
    ubreve: "ŭ",
    Ucirc: "Û",
    ucirc: "û",
    Ucy: "У",
    ucy: "у",
    udarr: "⇅",
    Udblac: "Ű",
    udblac: "ű",
    udhar: "⥮",
    ufisht: "⥾",
    Ufr: "\uD835\uDD18",
    ufr: "\uD835\uDD32",
    Ugrave: "Ù",
    ugrave: "ù",
    uHar: "⥣",
    uharl: "↿",
    uharr: "↾",
    uhblk: "▀",
    ulcorn: "⌜",
    ulcorner: "⌜",
    ulcrop: "⌏",
    ultri: "◸",
    Umacr: "Ū",
    umacr: "ū",
    uml: "¨",
    UnderBar: "_",
    UnderBrace: "⏟",
    UnderBracket: "⎵",
    UnderParenthesis: "⏝",
    Union: "⋃",
    UnionPlus: "⊎",
    Uogon: "Ų",
    uogon: "ų",
    Uopf: "\uD835\uDD4C",
    uopf: "\uD835\uDD66",
    UpArrow: "↑",
    Uparrow: "⇑",
    uparrow: "↑",
    UpArrowBar: "⤒",
    UpArrowDownArrow: "⇅",
    UpDownArrow: "↕",
    Updownarrow: "⇕",
    updownarrow: "↕",
    UpEquilibrium: "⥮",
    upharpoonleft: "↿",
    upharpoonright: "↾",
    uplus: "⊎",
    UpperLeftArrow: "↖",
    UpperRightArrow: "↗",
    Upsi: "ϒ",
    upsi: "υ",
    upsih: "ϒ",
    Upsilon: "Υ",
    upsilon: "υ",
    UpTee: "⊥",
    UpTeeArrow: "↥",
    upuparrows: "⇈",
    urcorn: "⌝",
    urcorner: "⌝",
    urcrop: "⌎",
    Uring: "Ů",
    uring: "ů",
    urtri: "◹",
    Uscr: "\uD835\uDCB0",
    uscr: "\uD835\uDCCA",
    utdot: "⋰",
    Utilde: "Ũ",
    utilde: "ũ",
    utri: "▵",
    utrif: "▴",
    uuarr: "⇈",
    Uuml: "Ü",
    uuml: "ü",
    uwangle: "⦧",
    vangrt: "⦜",
    varepsilon: "ϵ",
    varkappa: "ϰ",
    varnothing: "∅",
    varphi: "ϕ",
    varpi: "ϖ",
    varpropto: "∝",
    vArr: "⇕",
    varr: "↕",
    varrho: "ϱ",
    varsigma: "ς",
    varsubsetneq: "⊊︀",
    varsubsetneqq: "⫋︀",
    varsupsetneq: "⊋︀",
    varsupsetneqq: "⫌︀",
    vartheta: "ϑ",
    vartriangleleft: "⊲",
    vartriangleright: "⊳",
    Vbar: "⫫",
    vBar: "⫨",
    vBarv: "⫩",
    Vcy: "В",
    vcy: "в",
    VDash: "⊫",
    Vdash: "⊩",
    vDash: "⊨",
    vdash: "⊢",
    Vdashl: "⫦",
    Vee: "⋁",
    vee: "∨",
    veebar: "⊻",
    veeeq: "≚",
    vellip: "⋮",
    Verbar: "‖",
    verbar: "|",
    Vert: "‖",
    vert: "|",
    VerticalBar: "∣",
    VerticalLine: "|",
    VerticalSeparator: "❘",
    VerticalTilde: "≀",
    VeryThinSpace: " ",
    Vfr: "\uD835\uDD19",
    vfr: "\uD835\uDD33",
    vltri: "⊲",
    vnsub: "⊂⃒",
    vnsup: "⊃⃒",
    Vopf: "\uD835\uDD4D",
    vopf: "\uD835\uDD67",
    vprop: "∝",
    vrtri: "⊳",
    Vscr: "\uD835\uDCB1",
    vscr: "\uD835\uDCCB",
    vsubnE: "⫋︀",
    vsubne: "⊊︀",
    vsupnE: "⫌︀",
    vsupne: "⊋︀",
    Vvdash: "⊪",
    vzigzag: "⦚",
    Wcirc: "Ŵ",
    wcirc: "ŵ",
    wedbar: "⩟",
    Wedge: "⋀",
    wedge: "∧",
    wedgeq: "≙",
    weierp: "℘",
    Wfr: "\uD835\uDD1A",
    wfr: "\uD835\uDD34",
    Wopf: "\uD835\uDD4E",
    wopf: "\uD835\uDD68",
    wp: "℘",
    wr: "≀",
    wreath: "≀",
    Wscr: "\uD835\uDCB2",
    wscr: "\uD835\uDCCC",
    xcap: "⋂",
    xcirc: "◯",
    xcup: "⋃",
    xdtri: "▽",
    Xfr: "\uD835\uDD1B",
    xfr: "\uD835\uDD35",
    xhArr: "⟺",
    xharr: "⟷",
    Xi: "Ξ",
    xi: "ξ",
    xlArr: "⟸",
    xlarr: "⟵",
    xmap: "⟼",
    xnis: "⋻",
    xodot: "⨀",
    Xopf: "\uD835\uDD4F",
    xopf: "\uD835\uDD69",
    xoplus: "⨁",
    xotime: "⨂",
    xrArr: "⟹",
    xrarr: "⟶",
    Xscr: "\uD835\uDCB3",
    xscr: "\uD835\uDCCD",
    xsqcup: "⨆",
    xuplus: "⨄",
    xutri: "△",
    xvee: "⋁",
    xwedge: "⋀",
    Yacute: "Ý",
    yacute: "ý",
    YAcy: "Я",
    yacy: "я",
    Ycirc: "Ŷ",
    ycirc: "ŷ",
    Ycy: "Ы",
    ycy: "ы",
    yen: "¥",
    Yfr: "\uD835\uDD1C",
    yfr: "\uD835\uDD36",
    YIcy: "Ї",
    yicy: "ї",
    Yopf: "\uD835\uDD50",
    yopf: "\uD835\uDD6A",
    Yscr: "\uD835\uDCB4",
    yscr: "\uD835\uDCCE",
    YUcy: "Ю",
    yucy: "ю",
    Yuml: "Ÿ",
    yuml: "ÿ",
    Zacute: "Ź",
    zacute: "ź",
    Zcaron: "Ž",
    zcaron: "ž",
    Zcy: "З",
    zcy: "з",
    Zdot: "Ż",
    zdot: "ż",
    zeetrf: "ℨ",
    ZeroWidthSpace: "​",
    Zeta: "Ζ",
    zeta: "ζ",
    Zfr: "ℨ",
    zfr: "\uD835\uDD37",
    ZHcy: "Ж",
    zhcy: "ж",
    zigrarr: "⇝",
    Zopf: "ℤ",
    zopf: "\uD835\uDD6B",
    Zscr: "\uD835\uDCB5",
    zscr: "\uD835\uDCCF",
    zwj: "‍",
    zwnj: "‌"
  });
  exports.entityMap = exports.HTML_ENTITIES;
});

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/@xmldom/xmldom/lib/sax.js
var require_sax = __commonJS(function(exports) {
  var conventions = require_conventions();
  var g = require_grammar();
  var errors = require_errors();
  var isHTMLEscapableRawTextElement = conventions.isHTMLEscapableRawTextElement;
  var isHTMLMimeType = conventions.isHTMLMimeType;
  var isHTMLRawTextElement = conventions.isHTMLRawTextElement;
  var hasOwn = conventions.hasOwn;
  var NAMESPACE = conventions.NAMESPACE;
  var ParseError = errors.ParseError;
  var DOMException = errors.DOMException;
  var S_TAG = 0;
  var S_ATTR = 1;
  var S_ATTR_SPACE = 2;
  var S_EQ = 3;
  var S_ATTR_NOQUOT_VALUE = 4;
  var S_ATTR_END = 5;
  var S_TAG_SPACE = 6;
  var S_TAG_CLOSE = 7;
  function XMLReader() {}
  XMLReader.prototype = {
    parse: function(source, defaultNSMap, entityMap) {
      var domBuilder = this.domBuilder;
      domBuilder.startDocument();
      _copy(defaultNSMap, defaultNSMap = Object.create(null));
      parse(source, defaultNSMap, entityMap, domBuilder, this.errorHandler);
      domBuilder.endDocument();
    }
  };
  var ENTITY_REG = /&#?\w+;?/g;
  function parse(source, defaultNSMapCopy, entityMap, domBuilder, errorHandler) {
    var isHTML = isHTMLMimeType(domBuilder.mimeType);
    if (source.indexOf(g.UNICODE_REPLACEMENT_CHARACTER) >= 0) {
      errorHandler.warning("Unicode replacement character detected, source encoding issues?");
    }
    function fixedFromCharCode(code) {
      if (code > 65535) {
        code -= 65536;
        var surrogate1 = 55296 + (code >> 10), surrogate2 = 56320 + (code & 1023);
        return String.fromCharCode(surrogate1, surrogate2);
      } else {
        return String.fromCharCode(code);
      }
    }
    function entityReplacer(a) {
      var complete = a[a.length - 1] === ";" ? a : a + ";";
      if (!isHTML && complete !== a) {
        errorHandler.error("EntityRef: expecting ;");
        return a;
      }
      var match = g.Reference.exec(complete);
      if (!match || match[0].length !== complete.length) {
        errorHandler.error("entity not matching Reference production: " + a);
        return a;
      }
      var k = complete.slice(1, -1);
      if (hasOwn(entityMap, k)) {
        return entityMap[k];
      } else if (k.charAt(0) === "#") {
        return fixedFromCharCode(parseInt(k.substring(1).replace("x", "0x")));
      } else {
        errorHandler.error("entity not found:" + a);
        return a;
      }
    }
    function appendText(end) {
      if (end > start) {
        var xt = source.substring(start, end).replace(ENTITY_REG, entityReplacer);
        locator && position(start);
        domBuilder.characters(xt, 0, end - start);
        start = end;
      }
    }
    var lineStart = 0;
    var lineEnd = 0;
    var linePattern = /\r\n?|\n|$/g;
    var locator = domBuilder.locator;
    function position(p, m) {
      while (p >= lineEnd && (m = linePattern.exec(source))) {
        lineStart = lineEnd;
        lineEnd = m.index + m[0].length;
        locator.lineNumber++;
      }
      locator.columnNumber = p - lineStart + 1;
    }
    var parseStack = [{ currentNSMap: defaultNSMapCopy }];
    var unclosedTags = [];
    var start = 0;
    while (true) {
      try {
        var tagStart = source.indexOf("<", start);
        if (tagStart < 0) {
          if (!isHTML && unclosedTags.length > 0) {
            return errorHandler.fatalError("unclosed xml tag(s): " + unclosedTags.join(", "));
          }
          if (!source.substring(start).match(/^\s*$/)) {
            var doc = domBuilder.doc;
            var text = doc.createTextNode(source.substring(start));
            if (doc.documentElement) {
              return errorHandler.error("Extra content at the end of the document");
            }
            doc.appendChild(text);
            domBuilder.currentElement = text;
          }
          return;
        }
        if (tagStart > start) {
          var fromSource = source.substring(start, tagStart);
          if (!isHTML && unclosedTags.length === 0) {
            fromSource = fromSource.replace(new RegExp(g.S_OPT.source, "g"), "");
            fromSource && errorHandler.error("Unexpected content outside root element: '" + fromSource + "'");
          }
          appendText(tagStart);
        }
        switch (source.charAt(tagStart + 1)) {
          case "/":
            var end = source.indexOf(">", tagStart + 2);
            var tagNameRaw = source.substring(tagStart + 2, end > 0 ? end : undefined);
            if (!tagNameRaw) {
              return errorHandler.fatalError("end tag name missing");
            }
            var endTagNameStrict = g.reg("^", g.QName_group, g.S_OPT, "$");
            var tagNameMatch = end > 0 && endTagNameStrict.exec(tagNameRaw);
            if (!tagNameMatch) {
              var leadingTagNameMatch = end > 0 && g.reg("^", g.QName_group).exec(tagNameRaw);
              if (isHTML && leadingTagNameMatch) {
                errorHandler.warning('end tag name contains invalid trailing characters: "' + tagNameRaw + '"');
                tagNameMatch = leadingTagNameMatch;
              } else if (leadingTagNameMatch && new RegExp(endTagNameStrict.source, endTagNameStrict.flags + "m").test(tagNameRaw)) {
                errorHandler.error('end tag name is followed by a line break and trailing content: "' + tagNameRaw + '"');
                tagNameMatch = leadingTagNameMatch;
              } else {
                return errorHandler.fatalError('end tag name contains invalid characters: "' + tagNameRaw + '"');
              }
            }
            if (!domBuilder.currentElement && !domBuilder.doc.documentElement) {
              return;
            }
            var currentTagName = unclosedTags[unclosedTags.length - 1] || domBuilder.currentElement.tagName || domBuilder.doc.documentElement.tagName || "";
            if (currentTagName !== tagNameMatch[1]) {
              var tagNameLower = tagNameMatch[1].toLowerCase();
              if (!isHTML || currentTagName.toLowerCase() !== tagNameLower) {
                return errorHandler.fatalError('Opening and ending tag mismatch: "' + currentTagName + '" != "' + tagNameRaw + '"');
              }
            }
            var config = parseStack.pop();
            unclosedTags.pop();
            var localNSMap = config.localNSMap;
            domBuilder.endElement(config.uri, config.localName, currentTagName);
            if (localNSMap) {
              for (var prefix in localNSMap) {
                if (hasOwn(localNSMap, prefix)) {
                  domBuilder.endPrefixMapping(prefix);
                }
              }
            }
            end++;
            break;
          case "?":
            locator && position(tagStart);
            end = parseProcessingInstruction(source, tagStart, domBuilder, errorHandler);
            break;
          case "!":
            locator && position(tagStart);
            end = parseDoctypeCommentOrCData(source, tagStart, domBuilder, errorHandler, isHTML);
            break;
          default:
            locator && position(tagStart);
            var el = new ElementAttributes;
            var currentNSMap = parseStack[parseStack.length - 1].currentNSMap;
            var end = parseElementStartPart(source, tagStart, el, currentNSMap, entityReplacer, errorHandler, isHTML);
            var len = el.length;
            if (!el.closed) {
              if (isHTML && conventions.isHTMLVoidElement(el.tagName)) {
                el.closed = true;
              } else {
                unclosedTags.push(el.tagName);
              }
            }
            if (locator && len) {
              var locator2 = copyLocator(locator, {});
              for (var i = 0;i < len; i++) {
                var a = el[i];
                position(a.offset);
                a.locator = copyLocator(locator, {});
              }
              domBuilder.locator = locator2;
              if (appendElement(el, domBuilder, currentNSMap)) {
                parseStack.push(el);
              }
              domBuilder.locator = locator;
            } else {
              if (appendElement(el, domBuilder, currentNSMap)) {
                parseStack.push(el);
              }
            }
            if (isHTML && !el.closed) {
              end = parseHtmlSpecialContent(source, end, el.tagName, entityReplacer, domBuilder);
            } else {
              end++;
            }
        }
      } catch (e) {
        if (e instanceof ParseError) {
          throw e;
        } else if (e instanceof DOMException) {
          return errorHandler.fatalError("Error constructing the DOM: " + e.name + ": " + e.message, e);
        }
        errorHandler.error("element parse error: " + e);
        end = -1;
      }
      if (end > start) {
        start = end;
      } else {
        appendText(Math.max(tagStart, start) + 1);
      }
    }
  }
  function copyLocator(f, t) {
    t.lineNumber = f.lineNumber;
    t.columnNumber = f.columnNumber;
    return t;
  }
  function parseElementStartPart(source, start, el, currentNSMap, entityReplacer, errorHandler, isHTML) {
    function addAttribute(qname, value, startIndex) {
      if (hasOwn(el.attributeNames, qname)) {
        return errorHandler.fatalError("Attribute " + qname + " redefined");
      }
      if (!isHTML && value.indexOf("<") >= 0) {
        return errorHandler.fatalError("Unescaped '<' not allowed in attributes values");
      }
      el.addValue(qname, value.replace(/[\t\n\r]/g, " ").replace(ENTITY_REG, entityReplacer), startIndex);
    }
    var attrName;
    var value;
    var p = ++start;
    var s = S_TAG;
    while (true) {
      var c = source.charAt(p);
      if (s === S_TAG && c === "<") {
        throw new Error("unexpected < in tag name: " + source.slice(start, p));
      }
      switch (c) {
        case "=":
          if (s === S_ATTR) {
            attrName = source.slice(start, p);
            s = S_EQ;
          } else if (s === S_ATTR_SPACE) {
            s = S_EQ;
          } else {
            throw new Error("attribute equal must after attrName");
          }
          break;
        case "'":
        case '"':
          if (s === S_EQ || s === S_ATTR) {
            if (s === S_ATTR) {
              errorHandler.warning('attribute value must after "="');
              attrName = source.slice(start, p);
            }
            start = p + 1;
            p = source.indexOf(c, start);
            if (p > 0) {
              value = source.slice(start, p);
              addAttribute(attrName, value, start - 1);
              s = S_ATTR_END;
            } else {
              throw new Error("attribute value no end '" + c + "' match");
            }
          } else if (s == S_ATTR_NOQUOT_VALUE) {
            value = source.slice(start, p);
            addAttribute(attrName, value, start);
            errorHandler.warning('attribute "' + attrName + '" missed start quot(' + c + ")!!");
            start = p + 1;
            s = S_ATTR_END;
          } else {
            throw new Error('attribute value must after "="');
          }
          break;
        case "/":
          switch (s) {
            case S_TAG:
              el.setTagName(source.slice(start, p));
            case S_ATTR_END:
            case S_TAG_SPACE:
            case S_TAG_CLOSE:
              s = S_TAG_CLOSE;
              el.closed = true;
            case S_ATTR_NOQUOT_VALUE:
            case S_ATTR:
              break;
            case S_ATTR_SPACE:
              el.closed = true;
              break;
            default:
              throw new Error("attribute invalid close char('/')");
          }
          break;
        case "":
          errorHandler.error("unexpected end of input");
          if (s == S_TAG) {
            el.setTagName(source.slice(start, p));
          }
          return p;
        case ">":
          switch (s) {
            case S_TAG:
              el.setTagName(source.slice(start, p));
            case S_ATTR_END:
            case S_TAG_SPACE:
            case S_TAG_CLOSE:
              break;
            case S_ATTR_NOQUOT_VALUE:
            case S_ATTR:
              value = source.slice(start, p);
              if (value.slice(-1) === "/") {
                el.closed = true;
                value = value.slice(0, -1);
              }
            case S_ATTR_SPACE:
              if (s === S_ATTR_SPACE) {
                value = attrName;
              }
              if (s == S_ATTR_NOQUOT_VALUE) {
                errorHandler.warning('attribute "' + value + '" missed quot(")!');
                addAttribute(attrName, value, start);
              } else {
                if (!isHTML) {
                  errorHandler.warning('attribute "' + value + '" missed value!! "' + value + '" instead!!');
                }
                addAttribute(value, value, start);
              }
              break;
            case S_EQ:
              if (!isHTML) {
                return errorHandler.fatalError(`AttValue: ' or " expected`);
              }
          }
          return p;
        case "":
          c = " ";
        default:
          if (c <= " ") {
            switch (s) {
              case S_TAG:
                el.setTagName(source.slice(start, p));
                s = S_TAG_SPACE;
                break;
              case S_ATTR:
                attrName = source.slice(start, p);
                s = S_ATTR_SPACE;
                break;
              case S_ATTR_NOQUOT_VALUE:
                var value = source.slice(start, p);
                errorHandler.warning('attribute "' + value + '" missed quot(")!!');
                addAttribute(attrName, value, start);
              case S_ATTR_END:
                s = S_TAG_SPACE;
                break;
            }
          } else {
            switch (s) {
              case S_ATTR_SPACE:
                if (!isHTML) {
                  errorHandler.warning('attribute "' + attrName + '" missed value!! "' + attrName + '" instead2!!');
                }
                addAttribute(attrName, attrName, start);
                start = p;
                s = S_ATTR;
                break;
              case S_ATTR_END:
                errorHandler.warning('attribute space is required"' + attrName + '"!!');
              case S_TAG_SPACE:
                s = S_ATTR;
                start = p;
                break;
              case S_EQ:
                s = S_ATTR_NOQUOT_VALUE;
                start = p;
                break;
              case S_TAG_CLOSE:
                throw new Error("elements closed character '/' and '>' must be connected to");
            }
          }
      }
      p++;
    }
  }
  function appendElement(el, domBuilder, currentNSMap) {
    var tagName = el.tagName;
    var localNSMap = null;
    var i = el.length;
    while (i--) {
      var a = el[i];
      var qName = a.qName;
      var value = a.value;
      var nsp = qName.indexOf(":");
      if (nsp > 0) {
        var prefix = a.prefix = qName.slice(0, nsp);
        var localName = qName.slice(nsp + 1);
        var nsPrefix = prefix === "xmlns" && localName;
      } else {
        localName = qName;
        prefix = null;
        nsPrefix = qName === "xmlns" && "";
      }
      a.localName = localName;
      if (nsPrefix !== false) {
        if (localNSMap == null) {
          localNSMap = Object.create(null);
          currentNSMap = Object.create(currentNSMap);
        }
        currentNSMap[nsPrefix] = localNSMap[nsPrefix] = value;
        a.uri = NAMESPACE.XMLNS;
        domBuilder.startPrefixMapping(nsPrefix, value);
      }
    }
    var i = el.length;
    while (i--) {
      a = el[i];
      if (a.prefix) {
        if (a.prefix === "xml") {
          a.uri = NAMESPACE.XML;
        }
        if (a.prefix !== "xmlns") {
          a.uri = currentNSMap[a.prefix];
        }
      }
    }
    var nsp = tagName.indexOf(":");
    if (nsp > 0) {
      prefix = el.prefix = tagName.slice(0, nsp);
      localName = el.localName = tagName.slice(nsp + 1);
    } else {
      prefix = null;
      localName = el.localName = tagName;
    }
    var ns = el.uri = currentNSMap[prefix || ""];
    domBuilder.startElement(ns, localName, tagName, el);
    if (el.closed) {
      domBuilder.endElement(ns, localName, tagName);
      if (localNSMap) {
        for (prefix in localNSMap) {
          if (hasOwn(localNSMap, prefix)) {
            domBuilder.endPrefixMapping(prefix);
          }
        }
      }
    } else {
      el.currentNSMap = currentNSMap;
      el.localNSMap = localNSMap;
      return true;
    }
  }
  function parseHtmlSpecialContent(source, elStartEnd, tagName, entityReplacer, domBuilder) {
    var isEscapableRaw = isHTMLEscapableRawTextElement(tagName);
    if (isEscapableRaw || isHTMLRawTextElement(tagName)) {
      var closeTag = new RegExp("</" + tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ">", "ig");
      closeTag.lastIndex = elStartEnd;
      var match = closeTag.exec(source);
      var elEndStart = match ? match.index : -1;
      if (elEndStart < 0) {
        return elStartEnd + 1;
      }
      var text = source.substring(elStartEnd + 1, elEndStart);
      if (isEscapableRaw) {
        text = text.replace(ENTITY_REG, entityReplacer);
      }
      domBuilder.characters(text, 0, text.length);
      return elEndStart;
    }
    return elStartEnd + 1;
  }
  function _copy(source, target) {
    for (var n in source) {
      if (hasOwn(source, n)) {
        target[n] = source[n];
      }
    }
  }
  function parseUtils(source, start) {
    var index = start;
    function char(n) {
      n = n || 0;
      return source.charAt(index + n);
    }
    function skip(n) {
      n = n || 1;
      index += n;
    }
    function skipBlanks() {
      var blanks = 0;
      while (index < source.length) {
        var c = char();
        if (c !== " " && c !== `
` && c !== "\t" && c !== "\r") {
          return blanks;
        }
        blanks++;
        skip();
      }
      return -1;
    }
    function substringFromIndex() {
      return source.substring(index);
    }
    function substringStartsWith(text) {
      return source.substring(index, index + text.length) === text;
    }
    function substringStartsWithCaseInsensitive(text) {
      return source.substring(index, index + text.length).toUpperCase() === text.toUpperCase();
    }
    function getMatch(args) {
      var expr = g.reg("^", args);
      var match = expr.exec(substringFromIndex());
      if (match) {
        skip(match[0].length);
        return match[0];
      }
      return null;
    }
    return {
      char,
      getIndex: function() {
        return index;
      },
      getMatch,
      getSource: function() {
        return source;
      },
      skip,
      skipBlanks,
      substringFromIndex,
      substringStartsWith,
      substringStartsWithCaseInsensitive
    };
  }
  function parseDoctypeInternalSubset(p, errorHandler) {
    function parsePI(p, errorHandler) {
      var match = g.PI.exec(p.substringFromIndex());
      if (!match) {
        return errorHandler.fatalError("processing instruction is not well-formed at position " + p.getIndex());
      }
      if (match[1].toLowerCase() === "xml") {
        return errorHandler.fatalError("xml declaration is only allowed at the start of the document, but found at position " + p.getIndex());
      }
      p.skip(match[0].length);
      return match[0];
    }
    var source = p.getSource();
    if (p.char() === "[") {
      p.skip(1);
      var intSubsetStart = p.getIndex();
      while (p.getIndex() < source.length) {
        p.skipBlanks();
        if (p.char() === "]") {
          var internalSubset = source.substring(intSubsetStart, p.getIndex());
          p.skip(1);
          return internalSubset;
        }
        var current = null;
        if (p.char() === "<" && p.char(1) === "!") {
          switch (p.char(2)) {
            case "E":
              if (p.char(3) === "L") {
                current = p.getMatch(g.elementdecl);
              } else if (p.char(3) === "N") {
                current = p.getMatch(g.EntityDecl);
              }
              break;
            case "A":
              current = p.getMatch(g.AttlistDecl);
              break;
            case "N":
              current = p.getMatch(g.NotationDecl);
              break;
            case "-":
              current = p.getMatch(g.Comment);
              break;
          }
        } else if (p.char() === "<" && p.char(1) === "?") {
          current = parsePI(p, errorHandler);
        } else if (p.char() === "%") {
          current = p.getMatch(g.PEReference);
        } else {
          return errorHandler.fatalError("Error detected in Markup declaration");
        }
        if (!current) {
          return errorHandler.fatalError("Error in internal subset at position " + p.getIndex());
        }
      }
      return errorHandler.fatalError("doctype internal subset is not well-formed, missing ]");
    }
  }
  function parseDoctypeCommentOrCData(source, start, domBuilder, errorHandler, isHTML) {
    var p = parseUtils(source, start);
    switch (isHTML ? p.char(2).toUpperCase() : p.char(2)) {
      case "-":
        var comment = p.getMatch(g.Comment);
        if (comment) {
          domBuilder.comment(comment, g.COMMENT_START.length, comment.length - g.COMMENT_START.length - g.COMMENT_END.length);
          return p.getIndex();
        } else {
          return errorHandler.fatalError("comment is not well-formed at position " + p.getIndex());
        }
      case "[":
        var cdata = p.getMatch(g.CDSect);
        if (cdata) {
          if (!isHTML && !domBuilder.currentElement) {
            return errorHandler.fatalError("CDATA outside of element");
          }
          domBuilder.startCDATA();
          domBuilder.characters(cdata, g.CDATA_START.length, cdata.length - g.CDATA_START.length - g.CDATA_END.length);
          domBuilder.endCDATA();
          return p.getIndex();
        } else {
          return errorHandler.fatalError("Invalid CDATA starting at position " + start);
        }
      case "D": {
        if (domBuilder.doc && domBuilder.doc.documentElement) {
          return errorHandler.fatalError("Doctype not allowed inside or after documentElement at position " + p.getIndex());
        }
        if (isHTML ? !p.substringStartsWithCaseInsensitive(g.DOCTYPE_DECL_START) : !p.substringStartsWith(g.DOCTYPE_DECL_START)) {
          return errorHandler.fatalError("Expected " + g.DOCTYPE_DECL_START + " at position " + p.getIndex());
        }
        p.skip(g.DOCTYPE_DECL_START.length);
        if (p.skipBlanks() < 1) {
          return errorHandler.fatalError("Expected whitespace after " + g.DOCTYPE_DECL_START + " at position " + p.getIndex());
        }
        var doctype = {
          name: undefined,
          publicId: undefined,
          systemId: undefined,
          internalSubset: undefined
        };
        doctype.name = p.getMatch(g.Name);
        if (!doctype.name)
          return errorHandler.fatalError("doctype name missing or contains unexpected characters at position " + p.getIndex());
        if (isHTML && doctype.name.toLowerCase() !== "html") {
          errorHandler.warning("Unexpected DOCTYPE in HTML document at position " + p.getIndex());
        }
        p.skipBlanks();
        if (p.substringStartsWith(g.PUBLIC) || p.substringStartsWith(g.SYSTEM)) {
          var match = g.ExternalID_match.exec(p.substringFromIndex());
          if (!match) {
            return errorHandler.fatalError("doctype external id is not well-formed at position " + p.getIndex());
          }
          if (match.groups.SystemLiteralOnly !== undefined) {
            doctype.systemId = match.groups.SystemLiteralOnly;
          } else {
            doctype.systemId = match.groups.SystemLiteral;
            doctype.publicId = match.groups.PubidLiteral;
          }
          p.skip(match[0].length);
        } else if (isHTML && p.substringStartsWithCaseInsensitive(g.SYSTEM)) {
          p.skip(g.SYSTEM.length);
          if (p.skipBlanks() < 1) {
            return errorHandler.fatalError("Expected whitespace after " + g.SYSTEM + " at position " + p.getIndex());
          }
          doctype.systemId = p.getMatch(g.ABOUT_LEGACY_COMPAT_SystemLiteral);
          if (!doctype.systemId) {
            return errorHandler.fatalError("Expected " + g.ABOUT_LEGACY_COMPAT + " in single or double quotes after " + g.SYSTEM + " at position " + p.getIndex());
          }
        }
        if (isHTML && doctype.systemId && !g.ABOUT_LEGACY_COMPAT_SystemLiteral.test(doctype.systemId)) {
          errorHandler.warning("Unexpected doctype.systemId in HTML document at position " + p.getIndex());
        }
        if (!isHTML) {
          p.skipBlanks();
          doctype.internalSubset = parseDoctypeInternalSubset(p, errorHandler);
        }
        p.skipBlanks();
        if (p.char() !== ">") {
          return errorHandler.fatalError("doctype not terminated with > at position " + p.getIndex());
        }
        p.skip(1);
        domBuilder.startDTD(doctype.name, doctype.publicId, doctype.systemId, doctype.internalSubset);
        domBuilder.endDTD();
        return p.getIndex();
      }
      default:
        return errorHandler.fatalError('Not well-formed XML starting with "<!" at position ' + start);
    }
  }
  function parseProcessingInstruction(source, start, domBuilder, errorHandler) {
    var match = source.substring(start).match(g.PI);
    if (!match) {
      return errorHandler.fatalError("Invalid processing instruction starting at position " + start);
    }
    if (match[1].toLowerCase() === "xml") {
      if (start > 0) {
        return errorHandler.fatalError("processing instruction at position " + start + " is an xml declaration which is only at the start of the document");
      }
      if (!g.XMLDecl.test(source.substring(start))) {
        return errorHandler.fatalError("xml declaration is not well-formed");
      }
    }
    domBuilder.processingInstruction(match[1], match[2]);
    return start + match[0].length;
  }
  function ElementAttributes() {
    this.attributeNames = Object.create(null);
  }
  ElementAttributes.prototype = {
    setTagName: function(tagName) {
      if (!g.QName_exact.test(tagName)) {
        throw new Error("invalid tagName:" + tagName);
      }
      this.tagName = tagName;
    },
    addValue: function(qName, value, offset) {
      if (!g.QName_exact.test(qName)) {
        throw new Error("invalid attribute:" + qName);
      }
      this.attributeNames[qName] = this.length;
      this[this.length++] = { qName, value, offset };
    },
    length: 0,
    getLocalName: function(i) {
      return this[i].localName;
    },
    getLocator: function(i) {
      return this[i].locator;
    },
    getQName: function(i) {
      return this[i].qName;
    },
    getURI: function(i) {
      return this[i].uri;
    },
    getValue: function(i) {
      return this[i].value;
    }
  };
  exports.XMLReader = XMLReader;
  exports.parseUtils = parseUtils;
  exports.parseDoctypeCommentOrCData = parseDoctypeCommentOrCData;
});

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/@xmldom/xmldom/lib/dom-parser.js
var require_dom_parser = __commonJS(function(exports) {
  var conventions = require_conventions();
  var dom = require_dom();
  var errors = require_errors();
  var entities = require_entities();
  var sax = require_sax();
  var DOMImplementation = dom.DOMImplementation;
  var hasDefaultHTMLNamespace = conventions.hasDefaultHTMLNamespace;
  var isHTMLMimeType = conventions.isHTMLMimeType;
  var isValidMimeType = conventions.isValidMimeType;
  var MIME_TYPE = conventions.MIME_TYPE;
  var NAMESPACE = conventions.NAMESPACE;
  var ParseError = errors.ParseError;
  var XMLReader = sax.XMLReader;
  function normalizeLineEndings(input) {
    return input.replace(/\r[\n\u0085]/g, `
`).replace(/[\r\u0085\u2028\u2029]/g, `
`);
  }
  function DOMParser(options2) {
    options2 = options2 || {};
    if (options2.locator === undefined) {
      options2.locator = true;
    }
    this.assign = options2.assign || conventions.assign;
    this.domHandler = options2.domHandler || DOMHandler;
    this.onError = options2.onError || options2.errorHandler;
    if (options2.errorHandler && typeof options2.errorHandler !== "function") {
      throw new TypeError("errorHandler object is no longer supported, switch to onError!");
    } else if (options2.errorHandler) {
      options2.errorHandler("warning", "The `errorHandler` option has been deprecated, use `onError` instead!", this);
    }
    this.normalizeLineEndings = options2.normalizeLineEndings || normalizeLineEndings;
    this.locator = !!options2.locator;
    this.xmlns = this.assign(Object.create(null), options2.xmlns);
  }
  DOMParser.prototype.parseFromString = function(source, mimeType) {
    if (!isValidMimeType(mimeType)) {
      throw new TypeError('DOMParser.parseFromString: the provided mimeType "' + mimeType + '" is not valid.');
    }
    var defaultNSMap = this.assign(Object.create(null), this.xmlns);
    var entityMap = entities.XML_ENTITIES;
    var defaultNamespace = defaultNSMap[""] || null;
    if (hasDefaultHTMLNamespace(mimeType)) {
      entityMap = entities.HTML_ENTITIES;
      defaultNamespace = NAMESPACE.HTML;
    } else if (mimeType === MIME_TYPE.XML_SVG_IMAGE) {
      defaultNamespace = NAMESPACE.SVG;
    }
    defaultNSMap[""] = defaultNamespace;
    defaultNSMap.xml = defaultNSMap.xml || NAMESPACE.XML;
    var domBuilder = new this.domHandler({
      mimeType,
      defaultNamespace,
      onError: this.onError
    });
    var locator = this.locator ? {} : undefined;
    if (this.locator) {
      domBuilder.setDocumentLocator(locator);
    }
    var sax = new XMLReader;
    sax.errorHandler = domBuilder;
    sax.domBuilder = domBuilder;
    var isXml = !conventions.isHTMLMimeType(mimeType);
    if (isXml && typeof source !== "string") {
      sax.errorHandler.fatalError("source is not a string");
    }
    sax.parse(this.normalizeLineEndings(String(source)), defaultNSMap, entityMap);
    if (!domBuilder.doc.documentElement) {
      sax.errorHandler.fatalError("missing root element");
    }
    return domBuilder.doc;
  };
  function DOMHandler(options2) {
    var opt = options2 || {};
    this.mimeType = opt.mimeType || MIME_TYPE.XML_APPLICATION;
    this.defaultNamespace = opt.defaultNamespace || null;
    this.cdata = false;
    this.currentElement = undefined;
    this.doc = undefined;
    this.locator = undefined;
    this.onError = opt.onError;
  }
  function position(locator, node) {
    node.lineNumber = locator.lineNumber;
    node.columnNumber = locator.columnNumber;
  }
  DOMHandler.prototype = {
    startDocument: function() {
      var impl = new DOMImplementation;
      this.doc = isHTMLMimeType(this.mimeType) ? impl.createHTMLDocument(false) : impl.createDocument(this.defaultNamespace, "");
    },
    startElement: function(namespaceURI, localName, qName, attrs) {
      var doc = this.doc;
      var el = doc.createElementNS(namespaceURI, qName || localName);
      var len = attrs.length;
      appendElement(this, el);
      this.currentElement = el;
      this.locator && position(this.locator, el);
      for (var i = 0;i < len; i++) {
        var namespaceURI = attrs.getURI(i);
        var value = attrs.getValue(i);
        var qName = attrs.getQName(i);
        var attr = doc.createAttributeNS(namespaceURI, qName);
        this.locator && position(attrs.getLocator(i), attr);
        attr.value = attr.nodeValue = value;
        el.setAttributeNode(attr);
      }
    },
    endElement: function(namespaceURI, localName, qName) {
      this.currentElement = this.currentElement.parentNode;
    },
    startPrefixMapping: function(prefix, uri) {},
    endPrefixMapping: function(prefix) {},
    processingInstruction: function(target, data) {
      var ins = this.doc.createProcessingInstruction(target, data);
      this.locator && position(this.locator, ins);
      appendElement(this, ins);
    },
    ignorableWhitespace: function(ch, start, length) {},
    characters: function(chars, start, length) {
      chars = _toString.apply(this, arguments);
      if (chars) {
        if (this.cdata) {
          var charNode = this.doc.createCDATASection(chars);
        } else {
          var charNode = this.doc.createTextNode(chars);
        }
        if (this.currentElement) {
          this.currentElement.appendChild(charNode);
        } else if (/^\s*$/.test(chars)) {
          this.doc.appendChild(charNode);
        }
        this.locator && position(this.locator, charNode);
      }
    },
    skippedEntity: function(name) {},
    endDocument: function() {
      this.doc.normalize();
    },
    setDocumentLocator: function(locator) {
      if (locator) {
        locator.lineNumber = 0;
      }
      this.locator = locator;
    },
    comment: function(chars, start, length) {
      chars = _toString.apply(this, arguments);
      var comm = this.doc.createComment(chars);
      this.locator && position(this.locator, comm);
      appendElement(this, comm);
    },
    startCDATA: function() {
      this.cdata = true;
    },
    endCDATA: function() {
      this.cdata = false;
    },
    startDTD: function(name, publicId, systemId, internalSubset) {
      var impl = this.doc.implementation;
      if (impl && impl.createDocumentType) {
        var dt = impl.createDocumentType(name, publicId, systemId, internalSubset);
        this.locator && position(this.locator, dt);
        appendElement(this, dt);
        this.doc.doctype = dt;
      }
    },
    reportError: function(level, message) {
      if (typeof this.onError === "function") {
        try {
          this.onError(level, message, this);
        } catch (e) {
          throw new ParseError("Reporting " + level + ' "' + message + '" caused ' + e, this.locator);
        }
      } else {
        console.error("[xmldom " + level + "]\t" + message, _locator(this.locator));
      }
    },
    warning: function(message) {
      this.reportError("warning", message);
    },
    error: function(message) {
      this.reportError("error", message);
    },
    fatalError: function(message, cause) {
      this.reportError("fatalError", message);
      throw new ParseError(message, this.locator, cause);
    }
  };
  function _locator(l) {
    if (l) {
      return `
@#[line:` + l.lineNumber + ",col:" + l.columnNumber + "]";
    }
  }
  function _toString(chars, start, length) {
    if (typeof chars == "string") {
      return chars.substr(start, length);
    } else {
      if (chars.length >= start + length || start) {
        return new java.lang.String(chars, start, length) + "";
      }
      return chars;
    }
  }
  "endDTD,startEntity,endEntity,attributeDecl,elementDecl,externalEntityDecl,internalEntityDecl,resolveEntity,getExternalSubset,notationDecl,unparsedEntityDecl".replace(/\w+/g, function(key) {
    DOMHandler.prototype[key] = function() {
      return null;
    };
  });
  function appendElement(handler, node) {
    if (!handler.currentElement) {
      handler.doc.appendChild(node);
    } else {
      handler.currentElement.appendChild(node);
    }
  }
  function onErrorStopParsing(level) {
    if (level === "error")
      throw "onErrorStopParsing";
  }
  function onWarningStopParsing() {
    throw "onWarningStopParsing";
  }
  exports.__DOMHandler = DOMHandler;
  exports.DOMParser = DOMParser;
  exports.normalizeLineEndings = normalizeLineEndings;
  exports.onErrorStopParsing = onErrorStopParsing;
  exports.onWarningStopParsing = onWarningStopParsing;
});

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/xlsx-cli.ts
import { readFileSync, realpathSync as realpathSync2, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/documents/clock.ts
var RealClock = {
  now: () => new Date,
  id: () => cryptoRandomHex(16)
};
function cryptoRandomHex(bytes) {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/documents/limits.ts
var DEFAULT_MAX_FILE_MB = 20;
var MAX_FILE_MB_ENV = "KIMCHI_DOCUMENT_MAX_MB";
function maxFileBytes(env = process.env) {
  const raw = env[MAX_FILE_MB_ENV];
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0)
      return parsed * 1024 * 1024;
  }
  return DEFAULT_MAX_FILE_MB * 1024 * 1024;
}
var ZIP_MIN_INFLATE_RATIO = 0.01;
var ZIP_GRACE_ENTRY_BYTES = 100 * 1024;
var ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
var ZIP_MAX_ENTRIES = 1e4;
var MAX_OUTPUT_CHARS = 50 * 1024;

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/documents/model.ts
class DocumentError extends Error {
  code;
  format;
  constructor(code, message, format) {
    super(message);
    this.name = "DocumentError";
    this.code = code;
    this.format = format;
  }
}
function isDocumentError(err) {
  return err instanceof DocumentError;
}

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/documents/ooxml/package.ts
var import_jszip = __toESM(require_jszip_min());

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/yauzl/index.js
var fs = __require("fs");
var zlib = __require("zlib");
var fd_slicer = require_fd_slicer();
var util = __require("util");
var EventEmitter = __require("events").EventEmitter;
var Transform = __require("stream").Transform;
var PassThrough = __require("stream").PassThrough;
var Writable = __require("stream").Writable;
var crc32 = typeof zlib.crc32 === "function" ? zlib.crc32 : require_crc32();
var $fromBufferPromise = fromBufferPromise;
function fromBufferPromise(buffer, options2) {
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { ...options2, lazyEntries: true }, function(err, zipfile) {
      if (err)
        return reject(err);
      resolve(zipfile);
    });
  });
}
function fromBuffer(buffer, options2, callback) {
  if (typeof options2 === "function") {
    callback = options2;
    options2 = null;
  }
  if (options2 == null)
    options2 = {};
  options2.autoClose = false;
  if (options2.lazyEntries == null)
    options2.lazyEntries = false;
  if (options2.decodeStrings == null)
    options2.decodeStrings = true;
  if (options2.validateEntrySizes == null)
    options2.validateEntrySizes = true;
  if (options2.strictFileNames == null)
    options2.strictFileNames = false;
  var reader = new fd_slicer.BufferSlicer(buffer);
  fromRandomAccessReader(reader, buffer.length, options2, callback);
}
function fromRandomAccessReader(reader, totalSize, options2, callback) {
  if (typeof options2 === "function") {
    callback = options2;
    options2 = null;
  }
  if (options2 == null)
    options2 = {};
  if (options2.autoClose == null)
    options2.autoClose = true;
  if (options2.lazyEntries == null)
    options2.lazyEntries = false;
  if (options2.decodeStrings == null)
    options2.decodeStrings = true;
  var decodeStrings = !!options2.decodeStrings;
  if (options2.validateEntrySizes == null)
    options2.validateEntrySizes = true;
  if (options2.strictFileNames == null)
    options2.strictFileNames = false;
  if (callback == null)
    callback = defaultCallback;
  if (typeof totalSize !== "number")
    throw new Error("expected totalSize parameter to be a number");
  if (totalSize > Number.MAX_SAFE_INTEGER) {
    throw new Error("zip file too large. only file sizes up to 2^52 are supported due to JavaScript's Number type being an IEEE 754 double.");
  }
  reader.ref();
  var eocdrWithoutCommentSize = 22;
  var zip64EocdlSize = 20;
  var maxCommentSize = 65535;
  var bufferSize = Math.min(zip64EocdlSize + eocdrWithoutCommentSize + maxCommentSize, totalSize);
  var buffer = newBuffer(bufferSize);
  var bufferReadStart = totalSize - buffer.length;
  readAndAssertNoEof(reader, buffer, 0, bufferSize, bufferReadStart, function(err) {
    if (err)
      return callback(err);
    for (var i = bufferSize - eocdrWithoutCommentSize;i >= 0; i -= 1) {
      if (buffer.readUInt32LE(i) !== 101010256)
        continue;
      var eocdrBuffer = buffer.subarray(i);
      var diskNumber = eocdrBuffer.readUInt16LE(4);
      var entryCount = eocdrBuffer.readUInt16LE(10);
      var centralDirectoryOffset = eocdrBuffer.readUInt32LE(16);
      var commentLength = eocdrBuffer.readUInt16LE(20);
      var expectedCommentLength = eocdrBuffer.length - eocdrWithoutCommentSize;
      if (commentLength !== expectedCommentLength) {
        return callback(new Error("Invalid comment length. Expected: " + expectedCommentLength + ". Found: " + commentLength + ". Are there extra bytes at the end of the file? Or is the end of central dir signature `PK☺☻` in the comment?"));
      }
      var comment = decodeStrings ? decodeBuffer(eocdrBuffer.subarray(22), false) : eocdrBuffer.subarray(22);
      if (i - zip64EocdlSize >= 0 && buffer.readUInt32LE(i - zip64EocdlSize) === 117853008) {
        var zip64EocdlBuffer = buffer.subarray(i - zip64EocdlSize, i - zip64EocdlSize + zip64EocdlSize);
        var zip64EocdrOffset = readUInt64LE(zip64EocdlBuffer, 8);
        var zip64EocdrBuffer = newBuffer(56);
        return readAndAssertNoEof(reader, zip64EocdrBuffer, 0, zip64EocdrBuffer.length, zip64EocdrOffset, function(err) {
          if (err)
            return callback(err);
          if (zip64EocdrBuffer.readUInt32LE(0) !== 101075792) {
            return callback(new Error("invalid zip64 end of central directory record signature"));
          }
          diskNumber = zip64EocdrBuffer.readUInt32LE(16);
          if (diskNumber !== 0) {
            return callback(new Error("multi-disk zip files are not supported: found disk number: " + diskNumber));
          }
          entryCount = readUInt64LE(zip64EocdrBuffer, 32);
          centralDirectoryOffset = readUInt64LE(zip64EocdrBuffer, 48);
          return callback(null, new ZipFile(reader, centralDirectoryOffset, totalSize, entryCount, comment, options2.autoClose, options2.lazyEntries, decodeStrings, options2.validateEntrySizes, options2.strictFileNames));
        });
      }
      if (diskNumber !== 0) {
        return callback(new Error("multi-disk zip files are not supported: found disk number: " + diskNumber));
      }
      return callback(null, new ZipFile(reader, centralDirectoryOffset, totalSize, entryCount, comment, options2.autoClose, options2.lazyEntries, decodeStrings, options2.validateEntrySizes, options2.strictFileNames));
    }
    callback(new Error("End of central directory record signature not found. Either not a zip file, or file is truncated."));
  });
}
util.inherits(ZipFile, EventEmitter);
function ZipFile(reader, centralDirectoryOffset, fileSize, entryCount, comment, autoClose, lazyEntries, decodeStrings, validateEntrySizes, strictFileNames) {
  var self2 = this;
  EventEmitter.call(self2);
  self2.reader = reader;
  self2.reader.on("error", function(err) {
    emitError(self2, err);
  });
  self2.reader.once("close", function() {
    self2.emit("close");
  });
  self2.readEntryCursor = centralDirectoryOffset;
  self2.fileSize = fileSize;
  self2.entryCount = entryCount;
  self2.comment = comment;
  self2.entriesRead = 0;
  self2.autoClose = !!autoClose;
  self2.lazyEntries = !!lazyEntries;
  self2.decodeStrings = !!decodeStrings;
  self2.validateEntrySizes = !!validateEntrySizes;
  self2.strictFileNames = !!strictFileNames;
  self2.isOpen = true;
  self2.emittedError = false;
  self2.hasEachEntryBeenCalled = false;
  if (!self2.lazyEntries)
    self2._readEntry();
}
ZipFile.prototype.close = function() {
  if (!this.isOpen)
    return;
  this.isOpen = false;
  this.reader.unref();
};
function emitErrorAndAutoClose(self2, err) {
  if (self2.autoClose)
    self2.close();
  emitError(self2, err);
}
function emitError(self2, err) {
  if (self2.emittedError)
    return;
  self2.emittedError = true;
  self2.emit("error", err);
}
ZipFile.prototype.readEntry = function() {
  if (!this.lazyEntries)
    throw new Error("readEntry() called without lazyEntries:true");
  this._readEntry();
};
ZipFile.prototype._readEntry = function() {
  var self2 = this;
  if (self2.entryCount === self2.entriesRead) {
    setImmediate(function() {
      if (self2.autoClose)
        self2.close();
      if (self2.emittedError)
        return;
      self2.emit("end");
    });
    return;
  }
  if (self2.emittedError)
    return;
  var buffer = newBuffer(46);
  readAndAssertNoEof(self2.reader, buffer, 0, buffer.length, self2.readEntryCursor, function(err) {
    if (err)
      return emitErrorAndAutoClose(self2, err);
    if (self2.emittedError)
      return;
    var entry = new Entry;
    var signature = buffer.readUInt32LE(0);
    if (signature !== 33639248)
      return emitErrorAndAutoClose(self2, new Error("invalid central directory file header signature: 0x" + signature.toString(16)));
    entry.versionMadeBy = buffer.readUInt16LE(4);
    entry.versionNeededToExtract = buffer.readUInt16LE(6);
    entry.generalPurposeBitFlag = buffer.readUInt16LE(8);
    entry.compressionMethod = buffer.readUInt16LE(10);
    entry.lastModFileTime = buffer.readUInt16LE(12);
    entry.lastModFileDate = buffer.readUInt16LE(14);
    entry.crc32 = buffer.readUInt32LE(16);
    entry.compressedSize = buffer.readUInt32LE(20);
    entry.uncompressedSize = buffer.readUInt32LE(24);
    entry.fileNameLength = buffer.readUInt16LE(28);
    entry.extraFieldLength = buffer.readUInt16LE(30);
    entry.fileCommentLength = buffer.readUInt16LE(32);
    entry.internalFileAttributes = buffer.readUInt16LE(36);
    entry.externalFileAttributes = buffer.readUInt32LE(38);
    entry.relativeOffsetOfLocalHeader = buffer.readUInt32LE(42);
    if (entry.generalPurposeBitFlag & 64)
      return emitErrorAndAutoClose(self2, new Error("strong encryption is not supported"));
    self2.readEntryCursor += 46;
    buffer = newBuffer(entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength);
    readAndAssertNoEof(self2.reader, buffer, 0, buffer.length, self2.readEntryCursor, function(err) {
      if (err)
        return emitErrorAndAutoClose(self2, err);
      if (self2.emittedError)
        return;
      entry.fileNameRaw = buffer.subarray(0, entry.fileNameLength);
      var fileCommentStart = entry.fileNameLength + entry.extraFieldLength;
      entry.extraFieldRaw = buffer.subarray(entry.fileNameLength, fileCommentStart);
      entry.fileCommentRaw = buffer.subarray(fileCommentStart, fileCommentStart + entry.fileCommentLength);
      try {
        entry.extraFields = parseExtraFields(entry.extraFieldRaw);
      } catch (err) {
        return emitErrorAndAutoClose(self2, err);
      }
      if (self2.decodeStrings) {
        var isUtf8 = (entry.generalPurposeBitFlag & 2048) !== 0;
        entry.fileComment = decodeBuffer(entry.fileCommentRaw, isUtf8);
        entry.fileName = getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, self2.strictFileNames);
        var errorMessage = validateFileName(entry.fileName);
        if (errorMessage != null)
          return emitErrorAndAutoClose(self2, new Error(errorMessage));
      } else {
        entry.fileComment = entry.fileCommentRaw;
        entry.fileName = entry.fileNameRaw;
      }
      entry.comment = entry.fileComment;
      self2.readEntryCursor += buffer.length;
      self2.entriesRead += 1;
      for (var i = 0;i < entry.extraFields.length; i++) {
        var extraField = entry.extraFields[i];
        if (extraField.id !== 1)
          continue;
        var zip64EiefBuffer = extraField.data;
        var index = 0;
        if (entry.uncompressedSize === 4294967295) {
          if (index + 8 > zip64EiefBuffer.length) {
            return emitErrorAndAutoClose(self2, new Error("zip64 extended information extra field does not include uncompressed size"));
          }
          entry.uncompressedSize = readUInt64LE(zip64EiefBuffer, index);
          index += 8;
        }
        if (entry.compressedSize === 4294967295) {
          if (index + 8 > zip64EiefBuffer.length) {
            return emitErrorAndAutoClose(self2, new Error("zip64 extended information extra field does not include compressed size"));
          }
          entry.compressedSize = readUInt64LE(zip64EiefBuffer, index);
          index += 8;
        }
        if (entry.relativeOffsetOfLocalHeader === 4294967295) {
          if (index + 8 > zip64EiefBuffer.length) {
            return emitErrorAndAutoClose(self2, new Error("zip64 extended information extra field does not include relative header offset"));
          }
          entry.relativeOffsetOfLocalHeader = readUInt64LE(zip64EiefBuffer, index);
          index += 8;
        }
        break;
      }
      if (self2.validateEntrySizes && entry.compressionMethod === 0) {
        var expectedCompressedSize = entry.uncompressedSize;
        if (entry.isEncrypted()) {
          expectedCompressedSize += 12;
        }
        if (entry.compressedSize !== expectedCompressedSize) {
          var msg = "compressed/uncompressed size mismatch for stored file: " + entry.compressedSize + " != " + entry.uncompressedSize;
          return emitErrorAndAutoClose(self2, new Error(msg));
        }
      }
      self2.emit("entry", entry);
      if (!self2.lazyEntries)
        self2._readEntry();
    });
  });
};
ZipFile.prototype.eachEntry = function() {
  const self2 = this;
  if (!self2.lazyEntries)
    throw new Error("eachEntry() requires lazyEntries: true");
  if (self2.hasEachEntryBeenCalled)
    throw new Error("eachEntry() must only be called once per ZipFile");
  self2.hasEachEntryBeenCalled = true;
  let pendingResolveReject = null;
  self2.on("entry", onEntry);
  self2.on("end", onEnd);
  self2.on("error", onError);
  function cleanup() {
    self2.removeListener("entry", onEntry);
    self2.removeListener("end", onEnd);
    self2.removeListener("error", onError);
    if (self2.autoClose)
      self2.close();
  }
  function onEntry(entry) {
    let { resolve } = pendingResolveReject;
    pendingResolveReject = null;
    resolve({ value: entry });
  }
  function onEnd() {
    let { resolve } = pendingResolveReject;
    pendingResolveReject = null;
    cleanup();
    resolve({ done: true });
  }
  function onError(err) {
    let { reject } = pendingResolveReject;
    pendingResolveReject = null;
    cleanup();
    reject(err);
  }
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      const promise = new Promise((resolve, reject) => {
        if (pendingResolveReject != null)
          throw new Error("next() called before previous Promise was resolved.");
        pendingResolveReject = { resolve, reject };
      });
      self2.readEntry();
      return promise;
    },
    return(value) {
      cleanup();
      return Promise.resolve({ done: true, value });
    },
    throw(value) {
      cleanup();
      return Promise.reject(value);
    }
  };
};
ZipFile.prototype.openReadStream = function(entry, options2, callback) {
  var self2 = this;
  var relativeStart = 0;
  var relativeEnd = entry.compressedSize;
  if (callback == null) {
    callback = options2;
    options2 = null;
  }
  if (options2 == null) {
    options2 = {};
  } else {
    if (options2.decodeFileData === false) {
      if (options2.decrypt != null) {
        throw new Error("cannot use options.decrypt when options.decodeFileData === false");
      }
      if (options2.decompress != null) {
        throw new Error("cannot use options.decompress when options.decodeFileData === false");
      }
    } else {
      if (options2.decrypt != null) {
        if (!entry.isEncrypted()) {
          throw new Error("options.decrypt can only be specified for encrypted entries. See also option decodeFileData.");
        }
        if (options2.decrypt !== false)
          throw new Error("invalid options.decrypt value: " + options2.decrypt);
        if (entry.isCompressed()) {
          if (options2.decompress !== false)
            throw new Error("entry is encrypted and compressed, and options.decompress !== false. See also option decodeFileData.");
        }
      }
      if (options2.decompress != null) {
        if (!entry.isCompressed()) {
          throw new Error("options.decompress can only be specified for compressed entries. See also option decodeFileData.");
        }
        if (!(options2.decompress === false || options2.decompress === true)) {
          throw new Error("invalid options.decompress value: " + options2.decompress);
        }
        decompress = options2.decompress;
      }
    }
    if (options2.start != null) {
      relativeStart = options2.start;
      if (relativeStart < 0)
        throw new Error("options.start < 0");
      if (relativeStart > entry.compressedSize)
        throw new Error("options.start > entry.compressedSize");
    }
    if (options2.end != null) {
      relativeEnd = options2.end;
      if (relativeEnd < 0)
        throw new Error("options.end < 0");
      if (relativeEnd > entry.compressedSize)
        throw new Error("options.end > entry.compressedSize");
      if (relativeEnd < relativeStart)
        throw new Error("options.end < options.start");
    }
  }
  var rawMode = options2.decodeFileData === false || (entry.compressionMethod === 0 || entry.compressionMethod === 8 && options2.decompress === false) && (!entry.isEncrypted() || options2.decrypt === false);
  if (options2.start != null || options2.end != null) {
    if (!rawMode)
      throw new Error("start/end range require options.decodeFileData === false for non-trivial encoded entries.");
  }
  if (!self2.isOpen)
    return callback(new Error("closed"));
  if (entry.isEncrypted() && !rawMode) {
    if (options2.decrypt !== false)
      return callback(new Error("entry is encrypted, and options.decodeFileData !== false"));
  }
  var decompress;
  if (rawMode) {
    decompress = false;
  } else if (entry.compressionMethod === 8) {
    decompress = options2.decodeFileData !== true;
  } else {
    return callback(new Error("unsupported compression method: " + entry.compressionMethod));
  }
  self2.readLocalFileHeader(entry, { minimal: true }, function(err, localFileHeader) {
    if (err)
      return callback(err);
    self2.openReadStreamLowLevel(localFileHeader.fileDataStart, entry.compressedSize, relativeStart, relativeEnd, decompress, entry.uncompressedSize, callback);
  });
};
ZipFile.prototype.openReadStreamLowLevel = function(fileDataStart, compressedSize, relativeStart, relativeEnd, decompress, uncompressedSize, callback) {
  var self2 = this;
  var fileDataEnd = fileDataStart + compressedSize;
  var readStream = self2.reader.createReadStream({
    start: fileDataStart + relativeStart,
    end: fileDataStart + relativeEnd
  });
  var endpointStream = readStream;
  if (decompress) {
    var destroyed = false;
    var inflateFilter = zlib.createInflateRaw();
    readStream.on("error", function(err) {
      setImmediate(function() {
        if (!destroyed)
          inflateFilter.emit("error", err);
      });
    });
    readStream.pipe(inflateFilter);
    if (self2.validateEntrySizes) {
      endpointStream = new AssertByteCountStream(uncompressedSize);
      inflateFilter.on("error", function(err) {
        setImmediate(function() {
          if (!destroyed)
            endpointStream.emit("error", err);
        });
      });
      inflateFilter.pipe(endpointStream);
    } else {
      endpointStream = inflateFilter;
    }
    installDestroyFn(endpointStream, function() {
      destroyed = true;
      if (inflateFilter !== endpointStream)
        inflateFilter.unpipe(endpointStream);
      readStream.unpipe(inflateFilter);
      readStream.destroy();
    });
  }
  callback(null, endpointStream);
};
ZipFile.prototype.readLocalFileHeader = function(entry, options2, callback) {
  var self2 = this;
  if (callback == null) {
    callback = options2;
    options2 = null;
  }
  if (options2 == null)
    options2 = {};
  self2.reader.ref();
  var buffer = newBuffer(30);
  readAndAssertNoEof(self2.reader, buffer, 0, buffer.length, entry.relativeOffsetOfLocalHeader, function(err) {
    try {
      if (err)
        return callback(err);
      var signature = buffer.readUInt32LE(0);
      if (signature !== 67324752) {
        return callback(new Error("invalid local file header signature: 0x" + signature.toString(16)));
      }
      var fileNameLength = buffer.readUInt16LE(26);
      var extraFieldLength = buffer.readUInt16LE(28);
      var fileDataStart = entry.relativeOffsetOfLocalHeader + 30 + fileNameLength + extraFieldLength;
      if (fileDataStart + entry.compressedSize > self2.fileSize) {
        return callback(new Error("file data overflows file bounds: " + fileDataStart + " + " + entry.compressedSize + " > " + self2.fileSize));
      }
      if (options2.minimal) {
        return callback(null, { fileDataStart });
      }
      var localFileHeader = new LocalFileHeader;
      localFileHeader.fileDataStart = fileDataStart;
      localFileHeader.versionNeededToExtract = buffer.readUInt16LE(4);
      localFileHeader.generalPurposeBitFlag = buffer.readUInt16LE(6);
      localFileHeader.compressionMethod = buffer.readUInt16LE(8);
      localFileHeader.lastModFileTime = buffer.readUInt16LE(10);
      localFileHeader.lastModFileDate = buffer.readUInt16LE(12);
      localFileHeader.crc32 = buffer.readUInt32LE(14);
      localFileHeader.compressedSize = buffer.readUInt32LE(18);
      localFileHeader.uncompressedSize = buffer.readUInt32LE(22);
      localFileHeader.fileNameLength = fileNameLength;
      localFileHeader.extraFieldLength = extraFieldLength;
      buffer = newBuffer(fileNameLength + extraFieldLength);
      self2.reader.ref();
      readAndAssertNoEof(self2.reader, buffer, 0, buffer.length, entry.relativeOffsetOfLocalHeader + 30, function(err) {
        try {
          if (err)
            return callback(err);
          localFileHeader.fileName = buffer.subarray(0, fileNameLength);
          localFileHeader.extraField = buffer.subarray(fileNameLength);
          return callback(null, localFileHeader);
        } finally {
          self2.reader.unref();
        }
      });
    } finally {
      self2.reader.unref();
    }
  });
};
ZipFile.prototype.openReadStreamPromise = function(entry, options2) {
  return new Promise((resolve, reject) => {
    this.openReadStream(entry, options2, function(err, readStream) {
      if (err)
        return reject(err);
      resolve(readStream);
    });
  });
};
ZipFile.prototype.openReadStreamLowLevelPromise = function(fileDataStart, compressedSize, relativeStart, relativeEnd, decompress, uncompressedSize) {
  return new Promise((resolve, reject) => {
    this.openReadStream(fileDataStart, compressedSize, relativeStart, relativeEnd, decompress, uncompressedSize, function(err, readStream) {
      if (err)
        return reject(err);
      resolve(readStream);
    });
  });
};
ZipFile.prototype.readLocalFileHeaderPromise = function(entry, options2) {
  return new Promise((resolve, reject) => {
    this.readLocalFileHeader(entry, options2, function(err, localFileHeader) {
      if (err)
        return reject(err);
      resolve(localFileHeader);
    });
  });
};
function Entry() {}
Entry.prototype.getLastModDate = function(options2) {
  if (options2 == null)
    options2 = {};
  if (!options2.forceDosFormat) {
    for (var i = 0;i < this.extraFields.length; i++) {
      var extraField = this.extraFields[i];
      if (extraField.id === 21589) {
        var data = extraField.data;
        if (data.length < 5)
          continue;
        var flags = data[0];
        var HAS_MTIME = 1;
        if (!(flags & HAS_MTIME))
          continue;
        var posixTimestamp = data.readInt32LE(1);
        return new Date(posixTimestamp * 1000);
      } else if (extraField.id === 10) {
        var data = extraField.data;
        if (data.length !== 32)
          continue;
        if (data.readUInt16LE(4) !== 1)
          continue;
        if (data.readUInt16LE(6) !== 24)
          continue;
        var hundredNanoSecondsSince1601 = data.readUInt32LE(8) + 4294967296 * data.readInt32LE(12);
        var millisecondsSince1970 = hundredNanoSecondsSince1601 / 1e4 - 11644473600000;
        return new Date(millisecondsSince1970);
      }
    }
  }
  return dosDateTimeToDate(this.lastModFileDate, this.lastModFileTime, options2.timezone);
};
Entry.prototype.canDecodeFileData = function() {
  return !this.isEncrypted() && (this.compressionMethod === 0 || this.compressionMethod === 8);
};
Entry.prototype.isEncrypted = function() {
  return (this.generalPurposeBitFlag & 1) !== 0;
};
Entry.prototype.isCompressed = function() {
  return this.compressionMethod === 8;
};
function LocalFileHeader() {}
function dosDateTimeToDate(date, time, timezone) {
  var day = date & 31;
  var month = (date >> 5 & 15) - 1;
  var year = (date >> 9 & 127) + 1980;
  var millisecond = 0;
  var second = (time & 31) * 2;
  var minute = time >> 5 & 63;
  var hour = time >> 11 & 31;
  if (timezone == null || timezone === "local") {
    return new Date(year, month, day, hour, minute, second, millisecond);
  } else if (timezone === "UTC") {
    return new Date(Date.UTC(year, month, day, hour, minute, second, millisecond));
  } else {
    throw new Error("unrecognized options.timezone: " + options.timezone);
  }
}
function getFileNameLowLevel(generalPurposeBitFlag, fileNameBuffer, extraFields, strictFileNames) {
  var fileName = null;
  for (var i = 0;i < extraFields.length; i++) {
    var extraField = extraFields[i];
    if (extraField.id === 28789) {
      if (extraField.data.length < 6) {
        continue;
      }
      if (extraField.data.readUInt8(0) !== 1) {
        continue;
      }
      var oldNameCrc32 = extraField.data.readUInt32LE(1);
      if (crc32(fileNameBuffer) !== oldNameCrc32) {
        continue;
      }
      fileName = decodeBuffer(extraField.data.subarray(5), true);
      break;
    }
  }
  if (fileName == null) {
    var isUtf8 = (generalPurposeBitFlag & 2048) !== 0;
    fileName = decodeBuffer(fileNameBuffer, isUtf8);
  }
  if (!strictFileNames) {
    fileName = fileName.replace(/\\/g, "/");
  }
  return fileName;
}
function validateFileName(fileName) {
  if (fileName.indexOf("\\") !== -1) {
    return "invalid characters in fileName: " + fileName;
  }
  if (/^[a-zA-Z]:/.test(fileName) || /^\//.test(fileName)) {
    return "absolute path: " + fileName;
  }
  if (fileName.split("/").indexOf("..") !== -1) {
    return "invalid relative path: " + fileName;
  }
  return null;
}
function parseExtraFields(extraFieldBuffer) {
  var extraFields = [];
  var i = 0;
  while (i < extraFieldBuffer.length - 3) {
    var headerId = extraFieldBuffer.readUInt16LE(i + 0);
    var dataSize = extraFieldBuffer.readUInt16LE(i + 2);
    var dataStart = i + 4;
    var dataEnd = dataStart + dataSize;
    if (dataEnd > extraFieldBuffer.length)
      throw new Error("extra field length exceeds extra field buffer size");
    var dataBuffer = extraFieldBuffer.subarray(dataStart, dataEnd);
    extraFields.push({
      id: headerId,
      data: dataBuffer
    });
    i = dataEnd;
  }
  return extraFields;
}
function readAndAssertNoEof(reader, buffer, offset, length, position, callback) {
  if (length === 0) {
    return setImmediate(function() {
      callback(null, newBuffer(0));
    });
  }
  reader.read(buffer, offset, length, position, function(err, bytesRead) {
    if (err)
      return callback(err);
    if (bytesRead < length) {
      return callback(new Error("unexpected EOF"));
    }
    callback();
  });
}
util.inherits(AssertByteCountStream, Transform);
function AssertByteCountStream(byteCount) {
  Transform.call(this);
  this.actualByteCount = 0;
  this.expectedByteCount = byteCount;
}
AssertByteCountStream.prototype._transform = function(chunk, encoding, cb) {
  this.actualByteCount += chunk.length;
  if (this.actualByteCount > this.expectedByteCount) {
    var msg = "too many bytes in the stream. expected " + this.expectedByteCount + ". got at least " + this.actualByteCount;
    return cb(new Error(msg));
  }
  cb(null, chunk);
};
AssertByteCountStream.prototype._flush = function(cb) {
  if (this.actualByteCount < this.expectedByteCount) {
    var msg = "not enough bytes in the stream. expected " + this.expectedByteCount + ". got only " + this.actualByteCount;
    return cb(new Error(msg));
  }
  cb();
};
util.inherits(RandomAccessReader, EventEmitter);
function RandomAccessReader() {
  EventEmitter.call(this);
  this.refCount = 0;
}
RandomAccessReader.prototype.ref = function() {
  this.refCount += 1;
};
RandomAccessReader.prototype.unref = function() {
  var self2 = this;
  self2.refCount -= 1;
  if (self2.refCount > 0)
    return;
  if (self2.refCount < 0)
    throw new Error("invalid unref");
  self2.close(onCloseDone);
  function onCloseDone(err) {
    if (err)
      return self2.emit("error", err);
    self2.emit("close");
  }
};
RandomAccessReader.prototype.createReadStream = function(options2) {
  if (options2 == null)
    options2 = {};
  var start = options2.start;
  var end = options2.end;
  if (start === end) {
    var emptyStream = new PassThrough;
    setImmediate(function() {
      emptyStream.end();
    });
    return emptyStream;
  }
  var stream = this._readStreamForRange(start, end);
  var destroyed = false;
  var refUnrefFilter = new RefUnrefFilter(this);
  stream.on("error", function(err) {
    setImmediate(function() {
      if (!destroyed)
        refUnrefFilter.emit("error", err);
    });
  });
  installDestroyFn(refUnrefFilter, function() {
    stream.unpipe(refUnrefFilter);
    refUnrefFilter.unref();
    stream.destroy();
  });
  var byteCounter = new AssertByteCountStream(end - start);
  refUnrefFilter.on("error", function(err) {
    setImmediate(function() {
      if (!destroyed)
        byteCounter.emit("error", err);
    });
  });
  installDestroyFn(byteCounter, function() {
    destroyed = true;
    refUnrefFilter.unpipe(byteCounter);
    refUnrefFilter.destroy();
  });
  return stream.pipe(refUnrefFilter).pipe(byteCounter);
};
RandomAccessReader.prototype._readStreamForRange = function(start, end) {
  throw new Error("not implemented");
};
RandomAccessReader.prototype.read = function(buffer, offset, length, position, callback) {
  var readStream = this.createReadStream({ start: position, end: position + length });
  var writeStream = new Writable;
  var written = 0;
  writeStream._write = function(chunk, encoding, cb) {
    chunk.copy(buffer, offset + written, 0, chunk.length);
    written += chunk.length;
    cb();
  };
  writeStream.on("finish", callback);
  readStream.on("error", function(error) {
    callback(error);
  });
  readStream.pipe(writeStream);
};
RandomAccessReader.prototype.close = function(callback) {
  setImmediate(callback);
};
util.inherits(RefUnrefFilter, PassThrough);
function RefUnrefFilter(context) {
  PassThrough.call(this);
  this.context = context;
  this.context.ref();
  this.unreffedYet = false;
}
RefUnrefFilter.prototype._flush = function(cb) {
  this.unref();
  cb();
};
RefUnrefFilter.prototype.unref = function(cb) {
  if (this.unreffedYet)
    return;
  this.unreffedYet = true;
  this.context.unref();
};
var cp437 = "\x00☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
function decodeBuffer(buffer, isUtf8) {
  if (isUtf8) {
    return buffer.toString("utf8");
  } else {
    var result = "";
    for (var i = 0;i < buffer.length; i++) {
      result += cp437[buffer[i]];
    }
    return result;
  }
}
function readUInt64LE(buffer, offset) {
  var lower32 = buffer.readUInt32LE(offset);
  var upper32 = buffer.readUInt32LE(offset + 4);
  return upper32 * 4294967296 + lower32;
}
var newBuffer;
if (typeof Buffer.allocUnsafe === "function") {
  newBuffer = function(len) {
    return Buffer.allocUnsafe(len);
  };
} else {
  newBuffer = function(len) {
    return new Buffer(len);
  };
}
function installDestroyFn(stream, fn) {
  if (typeof stream.destroy === "function") {
    stream._destroy = function(err, cb) {
      fn();
      if (cb != null)
        cb(err);
    };
  } else {
    stream.destroy = fn;
  }
}
function defaultCallback(err) {
  if (err)
    throw err;
}

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/node_modules/@xmldom/xmldom/lib/index.js
var conventions = require_conventions();
var $assign = conventions.assign;
var $hasDefaultHTMLNamespace = conventions.hasDefaultHTMLNamespace;
var $isHTMLMimeType = conventions.isHTMLMimeType;
var $isValidMimeType = conventions.isValidMimeType;
var $MIME_TYPE = conventions.MIME_TYPE;
var $NAMESPACE = conventions.NAMESPACE;
var errors = require_errors();
var $DOMException = errors.DOMException;
var $DOMExceptionName = errors.DOMExceptionName;
var $ExceptionCode = errors.ExceptionCode;
var $ParseError = errors.ParseError;
var dom = require_dom();
var $Attr = dom.Attr;
var $CDATASection = dom.CDATASection;
var $CharacterData = dom.CharacterData;
var $Comment = dom.Comment;
var $Document = dom.Document;
var $DocumentFragment = dom.DocumentFragment;
var $DocumentType = dom.DocumentType;
var $DOMImplementation = dom.DOMImplementation;
var $Element = dom.Element;
var $Entity = dom.Entity;
var $EntityReference = dom.EntityReference;
var $LiveNodeList = dom.LiveNodeList;
var $NamedNodeMap = dom.NamedNodeMap;
var $Node = dom.Node;
var $NodeList = dom.NodeList;
var $Notation = dom.Notation;
var $ProcessingInstruction = dom.ProcessingInstruction;
var $Text = dom.Text;
var $XMLSerializer = dom.XMLSerializer;
var domParser = require_dom_parser();
var $DOMParser = domParser.DOMParser;
var $normalizeLineEndings = domParser.normalizeLineEndings;
var $onErrorStopParsing = domParser.onErrorStopParsing;
var $onWarningStopParsing = domParser.onWarningStopParsing;

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/documents/ooxml/xml.ts
function parseXml(source) {
  const errors = [];
  let doc;
  try {
    doc = new $DOMParser({
      onError: (level, message) => {
        if (level !== "warning")
          errors.push(String(message));
      }
    }).parseFromString(source, "text/xml");
  } catch (err) {
    throw new Error(`XML parse failed: ${err.message}`);
  }
  if (errors.length > 0)
    throw new Error(`XML parse failed: ${errors.join("; ")}`);
  return doc;
}
function serializeXml(doc) {
  return new $XMLSerializer().serializeToString(doc);
}
function byTag(element, localName) {
  const nodes = element.getElementsByTagName("*");
  const out = [];
  for (let i = 0;i < nodes.length; i++) {
    const el = nodes.item(i);
    const tag = el.tagName;
    if (tag === localName || tag.endsWith(`:${localName}`))
      out.push(el);
  }
  return out;
}

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/documents/ooxml/package.ts
var UTF8_DECODER = new TextDecoder("utf-8");
var UTF8_ENCODER = new TextEncoder;
function classifyZipError(err, entry) {
  const msg = err.message;
  if (/absolute path|invalid relative path|invalid characters in fileName/.test(msg) || /too many bytes|too few bytes/.test(msg)) {
    return new DocumentError("safety-limit", entry ? `Zip entry ${entry} rejected: ${msg}` : `Zip archive rejected: ${msg}`);
  }
  return new DocumentError("corrupt", entry ? `Zip entry ${entry} failed to inflate: ${msg}` : `Not a readable zip package: ${msg}`);
}
async function censusZip(data) {
  let zipfile;
  try {
    zipfile = await $fromBufferPromise(Buffer.from(data));
  } catch (err) {
    throw classifyZipError(err);
  }
  const records = [];
  const entriesByName = new Map;
  try {
    for await (const entry of zipfile.eachEntry()) {
      const name = entry.fileName;
      const mode = entry.externalFileAttributes >>> 16;
      records.push({
        name,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        symlink: (mode & 61440) === 40960,
        dir: name.endsWith("/")
      });
      entriesByName.set(name, entry);
    }
  } catch (err) {
    throw classifyZipError(err);
  }
  return { records, zipfile, entriesByName };
}
function validateEntryName(name) {
  if (name.startsWith("/") || /^[A-Za-z]:[/\\]/.test(name)) {
    throw new DocumentError("safety-limit", `Zip entry uses an absolute path: ${name}`);
  }
  if (name.split(/[/\\]/).includes("..")) {
    throw new DocumentError("safety-limit", `Zip entry escapes the archive root: ${name}`);
  }
}
function enforceCaps(records) {
  if (records.length > ZIP_MAX_ENTRIES) {
    throw new DocumentError("safety-limit", `Zip entry count ${records.length} exceeds cap ${ZIP_MAX_ENTRIES}`);
  }
  let totalUncompressed = 0;
  for (const record of records) {
    if (record.name === "__proto__" || record.name === "constructor" || record.name === "prototype") {
      throw new DocumentError("safety-limit", `Zip entry name shadows an Object prototype key: ${record.name}`);
    }
    validateEntryName(record.name);
    if (record.symlink) {
      throw new DocumentError("safety-limit", `Zip entry is a symlink: ${record.name}`);
    }
    if (record.uncompressedSize > ZIP_GRACE_ENTRY_BYTES && record.compressedSize > 0) {
      const ratio = record.compressedSize / record.uncompressedSize;
      if (ratio < ZIP_MIN_INFLATE_RATIO) {
        throw new DocumentError("safety-limit", `Zip entry ${record.name} inflates ${Math.round(record.uncompressedSize / record.compressedSize)}:1 (cap 100:1)`);
      }
    }
    totalUncompressed += record.uncompressedSize;
  }
  if (totalUncompressed > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
    throw new DocumentError("safety-limit", `Zip total uncompressed size ${totalUncompressed} exceeds cap ${ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES}`);
  }
  return records.filter((r) => !r.dir);
}
async function inflateBounded(zipfile, entry) {
  const perEntryCap = entry.uncompressedSize + 4096;
  let stream;
  try {
    stream = await zipfile.openReadStreamPromise(entry);
  } catch (err) {
    throw new DocumentError("corrupt", `Cannot open zip entry ${entry.fileName}: ${err.message}`);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let actual = 0;
    let settled = false;
    stream.on("data", (chunk) => {
      if (settled)
        return;
      const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      actual += buf.length;
      if (actual > perEntryCap) {
        settled = true;
        stream.destroy?.();
        reject(new DocumentError("safety-limit", `Zip entry ${entry.fileName} inflates past its declared size (${entry.uncompressedSize} bytes declared, aborted at ${actual})`));
        return;
      }
      chunks.push(buf);
    });
    stream.on("end", () => {
      if (settled)
        return;
      settled = true;
      const out = new Uint8Array(actual);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      resolve(out);
    });
    stream.on("error", (err) => {
      if (settled)
        return;
      settled = true;
      reject(classifyZipError(err, entry.fileName));
    });
  });
}
async function openOoxml(data) {
  if (!(data[0] === 80 && data[1] === 75)) {
    throw new DocumentError("corrupt", "Not a zip package");
  }
  const { records, zipfile, entriesByName } = await censusZip(data);
  const entries = enforceCaps(records);
  const cache = new Map;
  const removed = new Set;
  let totalActual = 0;
  for (const record of entries) {
    const entry = entriesByName.get(record.name);
    if (!entry)
      throw new DocumentError("corrupt", `Central directory lists missing entry: ${record.name}`);
    const data = await inflateBounded(zipfile, entry);
    totalActual += data.length;
    if (totalActual > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new DocumentError("safety-limit", `Zip total inflated size exceeds cap (${ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES} bytes)`);
    }
    cache.set(record.name, { data, dirty: false });
  }
  zipfile.close();
  const pkg = {
    names: () => [...cache.keys()],
    getBytes: (name) => cache.get(name)?.data,
    putBytes: (name, bytes) => {
      validateEntryName(name);
      cache.set(name, { data: bytes, dirty: true });
    },
    getXml: (name) => {
      const bytes = cache.get(name)?.data;
      if (!bytes)
        throw new DocumentError("corrupt", `Missing XML part: ${name}`);
      return parseXml(UTF8_DECODER.decode(bytes));
    },
    hasXml: (name) => cache.has(name),
    putXml: (name, doc) => {
      validateEntryName(name);
      removed.delete(name);
      cache.set(name, { data: UTF8_ENCODER.encode(serializeXml(doc)), dirty: true });
    },
    remove: (name, opts) => {
      for (const part of [...cache.keys()]) {
        if (part === name || opts?.recursive && part.startsWith(name)) {
          cache.delete(part);
          removed.add(part);
        }
      }
    },
    save: async () => {
      const zip = new import_jszip.default;
      for (const [name, state] of cache) {
        if (!removed.has(name))
          zip.file(name, state.data);
      }
      return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    }
  };
  return pkg;
}

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/documents/xlsx-refs.ts
function columnLetter(index) {
  let n = index;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m - 1) / 26);
  }
  return s;
}
function columnIndex(letters) {
  if (!/^[A-Za-z]{1,3}$/.test(letters))
    return;
  let n = 0;
  for (const c of letters.toUpperCase())
    n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}
function parseCellRef(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]+)$/.exec(ref.trim());
  if (!m)
    return;
  const column = columnIndex(m[1]);
  const row = Number(m[2]);
  if (!column || row < 1)
    return;
  return { row, column };
}
function parseRangeRef(ref) {
  const [a, b] = ref.split(":");
  const start = parseCellRef(a);
  const end = b === undefined ? start : parseCellRef(b);
  if (!start || !end)
    return;
  if (end.row < start.row || end.column < start.column)
    return;
  return { start, end };
}
function splitSheetRef(token) {
  const quoted = /^'((?:[^']|'')+)'!(.+)$/.exec(token);
  if (quoted)
    return { sheet: quoted[1].replace(/''/g, "'"), ref: quoted[2] };
  const plain = /^([A-Za-z0-9_.]+)!(.+)$/.exec(token);
  if (plain)
    return { sheet: plain[1], ref: plain[2] };
  return { sheet: undefined, ref: token };
}

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/documents/extractors/xlsx.ts
var SIDE_PART_MAX_BYTES = 20 * 1024 * 1024;
function loadSharedStrings(pkg) {
  const bytes = pkg.getBytes("xl/sharedStrings.xml");
  if (!bytes)
    return [];
  if (bytes.length > SIDE_PART_MAX_BYTES) {
    throw new DocumentError("safety-limit", `sharedStrings.xml is ${(bytes.length / 1024 / 1024).toFixed(1)} MB raw — side parts are capped at ${SIDE_PART_MAX_BYTES / 1024 / 1024} MB`, "xlsx");
  }
  pkg.remove("xl/sharedStrings.xml");
  const xml = new TextDecoder().decode(bytes);
  const out = [];
  const si = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  for (let m = si.exec(xml);m !== null; m = si.exec(xml)) {
    out.push(unescapeXml(stripAllTags(m[1])));
  }
  return out;
}
function stripAllTags(fragment) {
  return fragment.replace(/<[^>]+>/g, "");
}
function unescapeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#38;#60;/g, "&lt;").replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(Number.parseInt(h, 16))).replace(/&amp;/g, "&");
}
var BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 27, 30, 36, 45, 46, 47, 50, 57]);
var BUILTIN_DATETIME_FMTS = new Set([22]);
function isDateFormatCode(code) {
  const cleaned = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(cleaned) || /^m{1,5}$/i.test(cleaned);
}
function loadStyles(pkg) {
  const bytes = pkg.getBytes("xl/styles.xml");
  if (!bytes)
    return { cellXfsNumFmt: [], customFmt: new Map };
  if (bytes.length > SIDE_PART_MAX_BYTES) {
    throw new DocumentError("safety-limit", "styles.xml exceeds the side-part cap", "xlsx");
  }
  const doc = parseXml(new TextDecoder().decode(bytes));
  const customFmt = new Map;
  for (const nf of byTag(doc, "numFmt")) {
    const id = Number(nf.getAttribute("numFmtId"));
    const code = nf.getAttribute("formatCode");
    if (Number.isFinite(id) && code)
      customFmt.set(id, code);
  }
  const cellXfsNumFmt = [];
  const cellXfs = byTag(doc, "cellXfs")[0];
  if (cellXfs) {
    for (const xf of byTag(cellXfs, "xf")) {
      cellXfsNumFmt.push(Number(xf.getAttribute("numFmtId") ?? 0));
    }
  }
  return { cellXfsNumFmt, customFmt };
}
function styleDateKind(styles, styleIndex) {
  const id = styles.cellXfsNumFmt[styleIndex] ?? 0;
  if (BUILTIN_DATETIME_FMTS.has(id))
    return "datetime";
  if (BUILTIN_DATE_FMTS.has(id))
    return "date";
  const code = styles.customFmt.get(id);
  if (!code || !isDateFormatCode(code))
    return;
  return /[hs]/i.test(code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "")) && /[ymd]/i.test(code) ? "datetime" : "date";
}
function serialToIso(serial, epoch1904, kind) {
  if (!epoch1904 && serial === 60)
    return kind === "date" ? "1900-02-29" : "1900-02-29 00:00";
  const base = epoch1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  let ms = base + Math.round(serial * 86400) * 1000;
  if (!epoch1904 && serial > 60)
    ms -= 86400 * 1000;
  const iso = new Date(ms).toISOString();
  return kind === "date" ? iso.slice(0, 10) : iso.replace("T", " ").slice(0, 16);
}
function loadSheets(pkg) {
  const wbBytes = pkg.getBytes("xl/workbook.xml");
  if (!wbBytes)
    throw new DocumentError("corrupt", "Missing xl/workbook.xml", "xlsx");
  const wb = parseXml(new TextDecoder().decode(wbBytes));
  const wbPr = byTag(wb, "workbookPr")[0];
  const epoch1904 = wbPr?.getAttribute("date1904") === "1" || wbPr?.getAttribute("date1904") === "true";
  const relsBytes = pkg.getBytes("xl/_rels/workbook.xml.rels");
  if (!relsBytes)
    throw new DocumentError("corrupt", "Missing xl/_rels/workbook.xml.rels", "xlsx");
  const rels = parseXml(new TextDecoder().decode(relsBytes));
  const targets = {};
  for (const r of byTag(rels, "Relationship")) {
    const id = r.getAttribute("Id");
    const target = r.getAttribute("Target");
    if (id && target)
      targets[id] = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  }
  const sheets = [];
  for (const s of byTag(wb, "sheets")[0] ? byTag(byTag(wb, "sheets")[0], "sheet") : []) {
    const relId = s.getAttribute("r:id");
    const part = relId ? targets[relId] : undefined;
    if (!part || !pkg.hasXml(part)) {
      throw new DocumentError("corrupt", `Sheet ${JSON.stringify(s.getAttribute("name"))} points at a missing part`, "xlsx");
    }
    const stateAttr = s.getAttribute("state");
    sheets.push({
      name: s.getAttribute("name") ?? `Sheet${sheets.length + 1}`,
      state: stateAttr === "hidden" ? "hidden" : stateAttr === "veryHidden" ? "veryHidden" : "visible",
      relId: relId ?? "",
      part
    });
  }
  if (sheets.length === 0)
    throw new DocumentError("corrupt", "Workbook has no sheets", "xlsx");
  return { sheets, epoch1904 };
}
function scanRowSpans(sheetXml) {
  const out = [];
  const openTag = /<row\s+([^>]*?)(\/?)>/g;
  for (let m = openTag.exec(sheetXml);m !== null; m = openTag.exec(sheetXml)) {
    const rowAttr = /\br="(\d+)"/.exec(m[1]);
    const row = rowAttr ? Number(rowAttr[1]) : out.length + 1;
    if (m[2] === "/") {
      out.push({ row, start: m.index, end: m.index + m[0].length });
      continue;
    }
    const close = sheetXml.indexOf("</row>", m.index);
    if (close < 0)
      throw new DocumentError("corrupt", `Unclosed <row r="${row}">`, "xlsx");
    out.push({ row, start: m.index, end: close + "</row>".length });
    openTag.lastIndex = close + "</row>".length;
  }
  return out;
}
var WRAP_OPEN = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
function parseRow(sheetXml, span, sst, styles, epoch1904, showFormulas) {
  const dom = parseXml(`${WRAP_OPEN}${sheetXml.slice(span.start, span.end)}</worksheet>`);
  const row = byTag(dom, "row")[0];
  if (!row)
    return [];
  const cells = [];
  for (const c of byTag(row, "c")) {
    const ref = c.getAttribute("r");
    if (!ref)
      continue;
    const parsed = parseCellRef(ref);
    if (!parsed)
      continue;
    const t = c.getAttribute("t");
    const s = Number(c.getAttribute("s") ?? 0);
    const f = byTag(c, "f")[0]?.textContent ?? undefined;
    const v = byTag(c, "v")[0]?.textContent ?? "";
    let value = v;
    if (t === "s")
      value = sst[Number(v)] ?? `⚠ shared string #${v}?`;
    else if (t === "b")
      value = v === "1" ? "TRUE" : "FALSE";
    else if (t === "inlineStr")
      value = stripAllTags(byTag(c, "is")[0] ? serializeInnerText(byTag(c, "is")[0]) : "");
    else if (t === "str")
      value = v;
    else if (t === "e")
      value = v || "#ERR";
    else if (v !== "" && styleDateKind(styles, s)) {
      value = serialToIso(Number(v), epoch1904, styleDateKind(styles, s));
    }
    let display = f ? showFormulas ? `=${f} → ${value}` : value : value;
    cells.push({ ref, row: parsed.row, column: parsed.column, display });
  }
  return cells;
}
function serializeInnerText(el) {
  let out = "";
  for (let i = 0;i < el.childNodes.length; i++) {
    const n = el.childNodes.item(i);
    if (n?.nodeType === 3 || n?.nodeType === 4)
      out += n.nodeValue ?? "";
    else if (n)
      out += serializeInnerText(n);
  }
  return out;
}
function resolveSheetIndex(infos, sheet) {
  if (typeof sheet === "number")
    return sheet - 1;
  const lower = sheet.toLowerCase();
  const i = infos.findIndex((s) => s.name.toLowerCase() === lower);
  if (i < 0) {
    throw new DocumentError("corrupt", `No sheet named ${JSON.stringify(sheet)} — sheets: ${infos.map((s) => s.name).join(", ")}`, "xlsx");
  }
  return i;
}
async function extractXlsx(data) {
  const pkg = await openOoxml(data);
  const { sheets: wbSheets, epoch1904 } = loadSheets(pkg);
  const sst = loadSharedStrings(pkg);
  const styles = loadStyles(pkg);
  const hasMacros = pkg.hasXml("xl/vbaProject.bin");
  const hasExternalLinks = pkg.names().some((n) => /^xl\/externalLinks\/externalLink\d+\.xml$/.test(n));
  const coreBytes = pkg.getBytes("docProps/core.xml");
  let title;
  let creator;
  if (coreBytes) {
    const core = parseXml(new TextDecoder().decode(coreBytes));
    title = byTag(core, "title")[0]?.textContent || undefined;
    creator = byTag(core, "creator")[0]?.textContent || undefined;
  }
  const spansBySheet = [];
  const sheetXmlBySheet = [];
  const infos = [];
  for (const sh of wbSheets) {
    const bytes = pkg.getBytes(sh.part);
    if (!bytes)
      throw new DocumentError("corrupt", `Missing sheet part ${sh.part}`, "xlsx");
    const xml = new TextDecoder().decode(bytes);
    pkg.remove(sh.part);
    sheetXmlBySheet.push(xml);
    const spans = scanRowSpans(xml);
    spansBySheet.push(spans);
    let lastRow = 0;
    let lastCol = 0;
    const dim = /<dimension\s+ref="[^"]*?([A-Z]{1,3})(\d+)"/.exec(xml);
    if (dim) {
      lastRow = Number(dim[2]);
      const col = parseCellRef(`${dim[1]}1`);
      lastCol = col?.column ?? 0;
    }
    const lastSpan = spans[spans.length - 1];
    infos.push({
      name: sh.name,
      state: sh.state,
      part: sh.part,
      lastRow: Math.max(lastRow, lastSpan?.row ?? 0),
      lastColumn: columnLetter(lastCol || 1),
      rowCount: spans.length
    });
  }
  const notes = [];
  if (hasMacros)
    notes.push("contains macros (vbaProject.bin) — read-only, preserved untouched by edits");
  if (hasExternalLinks)
    notes.push("has external links — never recalculated by this skill");
  if (infos.some((s) => s.state !== "visible"))
    notes.push(`hidden sheets: ${infos.filter((s) => s.state !== "visible").map((s) => s.name).join(", ")}`);
  const mergedBySheet = [];
  return {
    format: "xlsx",
    sheets: infos,
    notes,
    info: { title, creator, date1904: epoch1904, hasMacros, hasExternalLinks },
    sheetIndex(sheet) {
      return resolveSheetIndex(infos, sheet);
    },
    window(opts) {
      const index = resolveSheetIndex(infos, opts.sheet ?? 1);
      const info = infos[index];
      if (!info) {
        throw new DocumentError("corrupt", `No sheet ${opts.sheet} (workbook has ${infos.length} sheets)`, "xlsx");
      }
      const spans = spansBySheet[index];
      const sheetXml = sheetXmlBySheet[index];
      const startRow = Math.max(1, opts.startRow ?? 1);
      const endRow = Math.min(opts.endRow ?? info.lastRow, info.lastRow);
      const maxChars = opts.maxChars ?? MAX_OUTPUT_CHARS;
      const showFormulas = opts.showFormulas ?? false;
      const inWindow = spans.filter((s) => s.row >= startRow && s.row <= endRow);
      const allCells = [];
      let maxCol = 0;
      for (const span of inWindow) {
        const cells = parseRow(sheetXml, span, sst, styles, epoch1904, showFormulas);
        for (const c of cells)
          maxCol = Math.max(maxCol, c.column);
        allCells.push(...cells);
      }
      const byRow = new Map;
      for (const c of allCells) {
        let m = byRow.get(c.row);
        if (!m)
          byRow.set(c.row, m = new Map);
        m.set(c.column, c.display);
      }
      const header = ["", ...Array.from({ length: maxCol }, (_, i) => columnLetter(i + 1))];
      const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
      let used = 0;
      const truncNote = 200;
      const rowsPresent = inWindow.map((s) => s.row);
      let toRow = startRow - 1;
      for (const rowNum of rowsPresent) {
        const m = byRow.get(rowNum);
        const cells = [String(rowNum)];
        for (let col = 1;col <= maxCol; col++)
          cells.push(m?.get(col)?.replace(/\|/g, "\\|").replace(/\n/g, " ") ?? "");
        const line = `| ${cells.join(" | ")} |`;
        if (used + line.length + 1 + truncNote > maxChars)
          break;
        lines.push(line);
        used += line.length + 1;
        toRow = rowNum;
      }
      const truncated = rowsPresent.length > 0 && toRow < rowsPresent[rowsPresent.length - 1];
      const oob = mergedBySheet[index];
      return {
        sheet: info.name,
        fromRow: startRow,
        toRow,
        markdown: lines.join(`
`),
        truncated,
        merged: oob ?? []
      };
    }
  };
}
function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else
          inQuotes = false;
      } else
        field += c;
    } else if (c === '"')
      inQuotes = true;
    else if (c === ",")
      pushField();
    else if (c === "\r") {
      if (text[i + 1] === `
`)
        i++;
      pushRow();
    } else if (c === `
`)
      pushRow();
    else
      field += c;
    i++;
  }
  if (field !== "" || row.length > 0)
    pushRow();
  return rows;
}
function extractCsv(text) {
  const rows = parseCsv(text);
  const info = {
    name: "(csv)",
    state: "visible",
    part: "(text)",
    lastRow: rows.length,
    lastColumn: columnLetter(Math.max(1, ...rows.map((r) => r.length))),
    rowCount: rows.length
  };
  return {
    format: "csv",
    sheets: [info],
    notes: [],
    info: { date1904: false, hasMacros: false, hasExternalLinks: false },
    sheetIndex() {
      return 0;
    },
    window(opts = {}) {
      const startRow = Math.max(1, opts.startRow ?? 1);
      const endRow = Math.min(opts.endRow ?? rows.length, rows.length);
      const maxChars = opts.maxChars ?? MAX_OUTPUT_CHARS;
      const maxCol = Math.max(1, ...rows.slice(startRow - 1, endRow).map((r) => r.length));
      const header = ["", ...Array.from({ length: maxCol }, (_, i) => columnLetter(i + 1))];
      const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
      let used = 0;
      let toRow = startRow - 1;
      for (let r = startRow;r <= endRow; r++) {
        const line = `| ${[String(r), ...rows[r - 1].map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " "))].join(" | ")} |`;
        if (used + line.length + 1 > maxChars)
          break;
        lines.push(line);
        used += line.length + 1;
        toRow = r;
      }
      return {
        sheet: "(csv)",
        fromRow: startRow,
        toRow,
        markdown: lines.join(`
`),
        truncated: toRow < endRow,
        merged: []
      };
    }
  };
}

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/documents/formula-lint.ts
var PRE_2008_FUNCTIONS = new Set(("ABS ACCRINT ACCRINTM ADD ADDRESS AMORDEGRC AMORLINC AND AVERAGE AVERAGEA AVERAGEIF AVERAGEIFS " + "BESSELI BESSELJ BESSELK BESSELY BETADIST BETAINV BINOMDIST CEILING CELL CHIDIST CHIINV CHITEST CHOOSE " + "CLEAN CODE COLUMN COLUMNS COMBIN COMPLEX CONCATENATE CONFIDENCE CONVERT CORREL COS COSH COUNT COUNTA " + "COUNTBLANK COUNTIF COUNTIFS COUPDAYBS COUPDAYS COUPDAYSNC COUPNCD COUPNUM COUPPCD COVAR CRITBINOM DATE " + "DATEDIF DATEVALUE DAVERAGE DAY DAYS360 DB DCOUNT DCOUNTA DDB DEGREES DEVSQ DGET DISC DMAX DMIN DOLLAR " + "DOLLARDE DOLLARFR DPRODUCT DSTDEV DSTDEVP DSUM DURATION EDATE EFFECT EOMONTH ERF ERFC ERROR.TYPE EVEN " + "EXACT EXP EXPONDIST FACT FACTDOUBLE FALSE FDIST FIND FINDB FINV FISHER FISHERINV FIXED FLOOR FORECAST " + "FREQUENCY FTEST FV FVSCHEDULE GAMMADIST GAMMAINV GAMMALN GCD GEOMEAN GESTEP GROWTH HARMEAN HLOOKUP " + "HOUR HYPERLINK HYPGEOMDIST IF IFERROR INDEX INDIRECT INT INTERCEPT INTRATE IPMT IRR ISBLANK ISERR " + "ISERROR ISEVEN ISLOGICAL ISNA ISNONTEXT ISNUMBER ISODD ISPMT ISREF ISTEXT JIS KURT LARGE LCM LEFT " + "LEFTB LEN LENB LINEST LN LOG LOG10 LOGEST LOGINV LOGNORMDIST LOOKUP LOWER MATCH MAX MAXA MDETERM MDURATION " + "MEDIAN MID MIDB MIN MINA MINUTE MINVERSE MIRR MMULT MOD MODE MONTH MROUND MULTINOMIAL N NA NEGBINOMDIST " + "NETWORKDAYS NOMINAL NORMDIST NORMINV NORMSDIST NORMSINV NOT NOW NPER NPV OCT2BIN OCT2DEC OCT2HEX ODD " + "OFFSET OR PEARSON PERCENTILE PERCENTRANK PERMUT PHONETIC PI PMT POISSON POWER PPMT PRICE PRICEDISC " + "PRICEMAT PROB PRODUCT PROPER PV QUARTILE QUOTIENT RADIANS RAND RANDBETWEEN RANK RATE RECEIVED REPLACE " + "REPT RIGHT RIGHTB ROMAN ROUND ROUNDDOWN ROUNDUP ROW ROWS RSQ RTD SEARCH SEARCHB SECOND SERIESSUM SIGN " + "SIN SINH SKEW SLN SLOPE SMALL SORT SQRT SQRTPI STANDARDIZE STDEV STDEVA STDEVP STDEVPA STEYX SUBSTITUTE " + "SUBTOTAL SUM SUMIF SUMIFS SUMPRODUCT SUMSQ SUMX2MY2 SUMX2PY2 SUMXMY2 SYD T TAN TANH TBILLEQ TBILLPRICE " + "TBILLYIELD TDIST TEXT TIME TIMEVALUE TINV TODAY TRANSPOSE TREND TRIM TRIMMEAN TRUE TRUNC TTEST TYPE " + "UPPER VALUE VAR VARA VARP VARPA VDB VLOOKUP WEEKDAY WEIBULL WORKDAY XIRR XNPV YEAR YEARFRAC YIELD " + "YIELDDISC YIELDMAT ZTEST").split(/\s+/));
var POST_2007_FUNCTIONS = new Set(("AGGREGATE ARABIC BASE BETA.DIST BETA.INV BINOM.DIST BINOM.INV BITAND BITLSHIFT BITOR BITRSHIFT BITXOR " + "CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST COMBINA " + "CONFIDENCE.NORM CONFIDENCE.T COT COTH COVARIANCE.P COVARIANCE.S CSC CSCH DATEVALUE DAYS DECIMAL DEC2BIN " + "DEC2HEX DEC2OCT EOMONTH ERF.PRECISE ERFC.PRECISE EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST " + "FILTERXML FLOOR.MATH FLOOR.PRECISE FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV GAMMALN.PRECISE GAUSS " + "HYPGEOM.DIST IFNA IFS ISFORMULA ISO.CEILING ISOWEEKNUM LOGNORM.DIST LOGNORM.INV MAXIFS MID MINIFS MODE.MULT " + "MODE.SNGL MUNIT NEGBINOM.DIST NETWORKDAYS.INTL NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE PDURATION " + "PERCENTILE.EXC PERCENTILE.INC PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI POISSON.DIST P.STANDARDIZE " + "QUARTILE.EXC QUARTILE.INC RANK.AVG RANK.EQ RRI SEC SECH SHEET SHEETS SKEW.P STDEV.P STDEV.S SWITCH T.DIST " + "T.DIST.2T T.DIST.RT TEXTJOIN T.INV T.INV.2T T.TEST UNICHAR UNICODE VAR.P VAR.S WEEKDAY WEIBULL.DIST " + "WORKDAY.INTL XLOOKUP XMATCH Z.TEST FILTER SORT UNIQUE SEQUENCE LET LAMBDA RANDARRAY XLOOKUP CONCAT TEXTBEFORE " + "TEXTAFTER TEXTSPLIT VSTACK HSTACK TOCOL TOROW WRAPROWS WRAPCOLS TAKE DROP CHOOSEROWS CHOOSECOLS EXPAND").split(/\s+/));
var SPILL_FUNCTIONS = new Set("XLOOKUP XMATCH FILTER SORT UNIQUE SEQUENCE RANDARRAY TEXTSPLIT VSTACK HSTACK TOCOL TOROW WRAPCOLS TAKE DROP CHOOSEROWS CHOOSECOLS EXPAND".split(/\s+/));
function tokenize(formula) {
  const tokens = [];
  let i = 0;
  const n = formula.length;
  while (i < n) {
    const c = formula[i];
    if (c === '"') {
      const end = formula.indexOf('"', i + 1);
      if (end < 0) {
        tokens.push({ kind: "other", text: formula.slice(i) });
        i = n;
      } else {
        tokens.push({ kind: "other", text: formula.slice(i, end + 1) });
        i = end + 1;
      }
      continue;
    }
    const refMatch = formula.slice(i).match(/^('(?:[^']|'')+'|[A-Za-z0-9_.]+!)?\$?[A-Za-z]{1,3}\$?[0-9]+(:\$?[A-Za-z]{1,3}\$?[0-9]+)?/);
    if (refMatch) {
      const text = refMatch[0].endsWith("!") ? refMatch[0] : refMatch[0];
      tokens.push({ kind: "ref", text });
      i += refMatch[0].length;
      continue;
    }
    const funcMatch = formula.slice(i).match(/^(?:_xlfn\.)?([A-Z][A-Z0-9._]*)(?=\()/);
    if (funcMatch) {
      tokens.push({ kind: "func", text: funcMatch[0] });
      i += funcMatch[0].length;
      continue;
    }
    tokens.push({ kind: "other", text: c });
    i++;
  }
  return tokens;
}
function syntaxOk(formula) {
  let depth = 0;
  let inString = false;
  for (const c of formula) {
    if (inString) {
      if (c === '"')
        inString = false;
      continue;
    }
    if (c === '"')
      inString = true;
    else if (c === "(")
      depth++;
    else if (c === ")") {
      depth--;
      if (depth < 0)
        return false;
    }
  }
  return depth === 0 && !inString;
}
var MAX_ROWS = 1048576;
var MAX_COLS = 16384;
function lintFormula(formula, cell, sheets, currentSheet) {
  const findings = [];
  const body = formula.startsWith("=") ? formula.slice(1) : formula;
  if (!syntaxOk(body)) {
    findings.push({ formula, cell, rule: "unbalanced-syntax", message: "unbalanced parentheses or quotes" });
    return findings;
  }
  const byName = new Map(sheets.map((s) => [s.name.toLowerCase(), s]));
  for (const token of tokenize(body)) {
    if (token.kind === "func") {
      const name = token.text.replace(/^_xlfn\./, "").toUpperCase();
      if (!PRE_2008_FUNCTIONS.has(name) && !POST_2007_FUNCTIONS.has(name)) {
        findings.push({ formula, cell, rule: "unknown-function", message: `unknown function ${name}` });
        continue;
      }
      if (POST_2007_FUNCTIONS.has(name) && !token.text.startsWith("_xlfn.")) {
        findings.push({
          formula,
          cell,
          rule: "missing-xlfn",
          message: `${name} needs the _xlfn. prefix in file format (the writer adds it)`
        });
      }
      if (SPILL_FUNCTIONS.has(name)) {
        findings.push({
          formula,
          cell,
          rule: "spill-function",
          message: `${name} spills a range — older Excel versions show it as @-implicit and single-valued`
        });
      }
      continue;
    }
    if (token.kind === "ref") {
      const { sheet, ref } = splitSheetRef(token.text);
      const range = parseRangeRef(ref);
      if (!range)
        continue;
      if (sheet !== undefined) {
        const target = byName.get(sheet.toLowerCase());
        if (!target) {
          findings.push({
            formula,
            cell,
            rule: "unknown-sheet",
            message: `references sheet ${JSON.stringify(sheet)} which does not exist (${sheets.map((s) => s.name).join(", ")})`
          });
          continue;
        }
        if (range.end.row > Math.max(target.lastRow, 1) || range.end.column > Math.max(target.lastColumn, 1)) {
          findings.push({
            formula,
            cell,
            rule: "out-of-range-ref",
            message: `${token.text} reaches past sheet "${target.name}"'s data (${target.lastRow} rows, ${target.lastColumn} columns)`
          });
        }
      } else {
        if (range.end.row > MAX_ROWS || range.end.column > MAX_COLS) {
          findings.push({ formula, cell, rule: "out-of-range-ref", message: `${token.text} is beyond the sheet grid` });
        } else if (currentSheet && (range.end.row > Math.max(currentSheet.lastRow, 1) || range.end.column > Math.max(currentSheet.lastColumn, 1))) {
          findings.push({
            formula,
            cell,
            rule: "out-of-range-ref",
            message: `${token.text} reaches past the sheet's data (${currentSheet.lastRow} rows, ${currentSheet.lastColumn} columns)`
          });
        }
      }
    }
  }
  return findings;
}
function applyXlfnPrefixes(formula) {
  return formula.replace(/"[^"]*"|(?<![\w.]|_xlfn\.)([A-Z][A-Z0-9._]*)(?=\()/g, (m, name) => {
    if (!name)
      return m;
    return POST_2007_FUNCTIONS.has(name) ? `_xlfn.${name}` : m;
  });
}

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/documents/editors/xlsx.ts
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function listSheetParts(pkg) {
  const wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml") ?? new Uint8Array);
  const rels = new TextDecoder().decode(pkg.getBytes("xl/_rels/workbook.xml.rels") ?? new Uint8Array);
  const targets = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    targets[m[1]] = m[2].startsWith("/") ? m[2].slice(1) : `xl/${m[2]}`;
  }
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
    if (id && target)
      targets[id] = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  }
  const out = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1])?.[1];
    const relId = /\br:id="([^"]+)"/.exec(m[1])?.[1];
    const part = relId ? targets[relId] : undefined;
    if (name && part)
      out.push({ index: out.length, name: unescName(name), part });
  }
  return out;
}
function unescName(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function resolveSheet(pkg, selector) {
  const sheets = listSheetParts(pkg);
  if (sheets.length === 0)
    throw new DocumentError("corrupt", "workbook has no sheets", "xlsx");
  if (selector === undefined)
    return sheets[0];
  if (typeof selector === "number") {
    const sheet = sheets[selector - 1];
    if (!sheet)
      throw new DocumentError("corrupt", `No sheet ${selector} (workbook has ${sheets.length})`, "xlsx");
    return sheet;
  }
  const lower = selector.toLowerCase();
  const sheet = sheets.find((s) => s.name.toLowerCase() === lower);
  if (!sheet) {
    throw new DocumentError("corrupt", `No sheet named ${JSON.stringify(selector)} — sheets: ${sheets.map((s) => s.name).join(", ")}`, "xlsx");
  }
  return sheet;
}
function scanCells(rowFrag) {
  const spans = [];
  const re = /<c\b((?:(?!\/?>)[^>])*)\/?(>)/g;
  for (let m = re.exec(rowFrag);m !== null; m = re.exec(rowFrag)) {
    const attrs = m[1];
    const ref = /\br="([^"]+)"/.exec(attrs)?.[1];
    if (!ref)
      continue;
    const fullOpen = m[0];
    if (fullOpen.endsWith("/>")) {
      spans.push({ ref, full: fullOpen, start: m.index, end: m.index + fullOpen.length, attrs, selfClosed: true, inner: "" });
    } else {
      const close = rowFrag.indexOf("</c>", m.index);
      if (close < 0)
        throw new DocumentError("corrupt", `Unclosed <c r="${ref}">`, "xlsx");
      spans.push({
        ref,
        full: rowFrag.slice(m.index, close + 4),
        start: m.index,
        end: close + 4,
        attrs,
        selfClosed: false,
        inner: rowFrag.slice(m.index + fullOpen.length, close)
      });
    }
  }
  return spans;
}
function renderCell(ref, cell, keepAttrs, addStyle) {
  const styleAttr = (() => {
    if (addStyle !== undefined)
      return ` s="${addStyle}"`;
    const s = /\bs="([^"]*)"/.exec(keepAttrs)?.[1];
    return s !== undefined ? ` s="${s}"` : "";
  })();
  if (cell === null || cell === undefined)
    return "";
  if (typeof cell === "number")
    return `<c r="${ref}"${styleAttr}><v>${cell}</v></c>`;
  if (typeof cell === "boolean")
    return `<c r="${ref}"${styleAttr} t="b"><v>${cell ? 1 : 0}</v></c>`;
  if (typeof cell === "string")
    return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`;
  if (cell.f !== undefined) {
    const f = cell.f.startsWith("=") ? cell.f.slice(1) : cell.f;
    return `<c r="${ref}"${styleAttr}><f>${esc(applyXlfnPrefixes(f))}</f></c>`;
  }
  if (cell.v !== undefined && cell.v !== null) {
    if (typeof cell.v === "number")
      return `<c r="${ref}"${styleAttr}><v>${cell.v}</v></c>`;
    if (typeof cell.v === "boolean")
      return `<c r="${ref}"${styleAttr} t="b"><v>${cell.v ? 1 : 0}</v></c>`;
    return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${esc(String(cell.v))}</t></is></c>`;
  }
  return "";
}
function readGeometry(sheetXml) {
  const merges = [];
  for (const m of sheetXml.matchAll(/<mergeCell\s+ref="([^"]+)"/g)) {
    const r = parseRangeRef(m[1]);
    if (r)
      merges.push(r);
  }
  return { merges };
}
function applyRowEdits(sheetXml, edits) {
  const spans = scanRowSpans(sheetXml);
  const byRow = new Map(edits.map((e) => [e.row, e]));
  const parts = [];
  let cursor = 0;
  let touched = 0;
  for (const span of spans) {
    const edit = byRow.get(span.row);
    if (!edit)
      continue;
    parts.push(sheetXml.slice(cursor, span.start));
    const rowFrag = sheetXml.slice(span.start, span.end);
    const openEnd = rowFrag.indexOf(">");
    const open = rowFrag.slice(0, openEnd + 1);
    const newXml = rewriteRow(open, rowFrag.slice(openEnd + 1, rowFrag.length - "</row>".length), edit.replacements);
    parts.push(newXml);
    cursor = span.end;
    touched++;
    byRow.delete(span.row);
  }
  parts.push(sheetXml.slice(cursor));
  let xml = parts.join("");
  const missing = [...byRow.values()].sort((a, b) => a.row - b.row);
  if (missing.length > 0) {
    const insertion = missing.map((e) => `<row r="${e.row}">${rewriteRowCells([], e.replacements)}</row>`).join("");
    const closeIdx = xml.lastIndexOf("</sheetData>");
    const openSelfclose = /<sheetData\s*\/>/.exec(xml);
    if (closeIdx >= 0) {
      xml = `${xml.slice(0, closeIdx)}${insertion}</sheetData>${xml.slice(closeIdx + "</sheetData>".length)}`;
    } else if (openSelfclose) {
      xml = xml.replace(/<sheetData\s*\/>/, `<sheetData>${insertion}</sheetData>`);
    } else {
      throw new DocumentError("corrupt", "worksheet has no <sheetData>", "xlsx");
    }
    touched += missing.length;
  }
  return { xml, touched };
}
function rewriteRow(openTag, inner, replacements) {
  return `${openTag}${rewriteRowCells(scanCellsFromInner(inner), replacements)}</row>`;
}
function scanCellsFromInner(inner) {
  const cells = [];
  for (const span of scanCells(inner))
    cells.push(span);
  return cells;
}
function rewriteRowCells(existing, replacements) {
  const byRef = new Map(existing.map((c) => [c.ref.toUpperCase(), c]));
  const output = [];
  const handled = new Set;
  for (const [, rep] of [...replacements.entries()].sort((a, b) => a[0] - b[0])) {
    const ref = rep.ref.toUpperCase();
    const old = byRef.get(ref);
    if (old) {
      const xml = renderCell(ref, rep.cell, old.attrs);
      output.push({ col: replacements.get(parseCellRef(ref).column) ? parseCellRef(ref).column : parseCellRef(ref).column, xml, empty: xml === "" });
      handled.add(ref);
    } else {
      const xml = renderCell(ref, rep.cell, "");
      output.push({ col: parseCellRef(ref).column, xml, empty: xml === "" });
      handled.add(ref);
    }
  }
  for (const cell of existing) {
    if (!handled.has(cell.ref.toUpperCase())) {
      output.push({ col: parseCellRef(cell.ref).column, xml: cell.full, empty: false });
    }
  }
  output.sort((a, b) => a.col - b.col);
  return output.filter((o) => !o.empty).map((o) => o.xml).join("");
}
function updateDimension(sheetXml) {
  let maxRow = 0;
  let maxCol = 0;
  for (const m of sheetXml.matchAll(/<c\b[^>]*\br="([A-Z]{1,3})(\d+)"/g)) {
    maxCol = Math.max(maxCol, columnIndex((m[1] ?? "A").toUpperCase()) ?? 1);
    maxRow = Math.max(maxRow, Number(m[2] ?? 0));
  }
  for (const m of sheetXml.matchAll(/<row\b[^>]*\br="(\d+)"/g))
    maxRow = Math.max(maxRow, Number(m[1] ?? 0));
  const dim = maxRow === 0 ? `<dimension ref="A1"/>` : `<dimension ref="A1:${columnLetter(Math.max(maxCol, 1))}${maxRow}"/>`;
  if (/<dimension\b[^>]*\/>/.test(sheetXml))
    return sheetXml.replace(/<dimension\b[^>]*\/>/, dim);
  if (/<dimension\b[^>]*>.*?<\/dimension>/.test(sheetXml))
    return sheetXml.replace(/<dimension\b[^>]*>.*?<\/dimension>/, dim);
  return sheetXml.replace(/<worksheet\b([^>]*)>/, `<worksheet$1>${dim}`);
}
function ensureFullCalcOnLoad(pkg) {
  const wbBytes = pkg.getBytes("xl/workbook.xml");
  if (!wbBytes)
    return;
  let wb = new TextDecoder().decode(wbBytes);
  if (/<calcPr\b[^>]*\/>/.test(wb)) {
    wb = wb.replace(/<calcPr\b[^>]*\/>/, (m) => {
      return m.includes("fullCalcOnLoad") ? m : m.replace("/>", "") + ' fullCalcOnLoad="1"/>';
    });
  } else {
    wb = wb.replace(/<\/workbook>/, `<calcPr fullCalcOnLoad="1"/></workbook>`);
  }
  pkg.putBytes("xl/workbook.xml", new TextEncoder().encode(wb));
}
function removeCalcChain(pkg) {
  if (pkg.hasXml("xl/calcChain.xml"))
    pkg.remove("xl/calcChain.xml");
}
function applyXlsxOps(pkg, ops) {
  const result = { applied: [], formulasWritten: 0, formulasAlert: false, macrosPreserved: pkg.hasXml("xl/vbaProject.bin") };
  let formulasTouched = false;
  for (const [opIndex, op] of ops.entries()) {
    switch (op.kind) {
      case "set-cells": {
        const sheet = resolveSheet(pkg, op.sheet);
        const xmlBytes = pkg.getBytes(sheet.part);
        if (!xmlBytes)
          throw new DocumentError("corrupt", `missing sheet part ${sheet.part}`, "xlsx");
        let xml = new TextDecoder().decode(xmlBytes);
        const edits = new Map;
        for (const [key, cell] of Object.entries(op.cells)) {
          const { sheet: sheetName, ref } = splitSheetRef(key);
          if (sheetName !== undefined && sheetName.toLowerCase() !== sheet.name.toLowerCase()) {
            throw new DocumentError("corrupt", `op ${opIndex + 1}: cell ${key} names a different sheet than --sheet`, "xlsx");
          }
          const parsed = parseCellRef(ref);
          if (!parsed)
            throw new DocumentError("corrupt", `op ${opIndex + 1}: bad cell ref ${JSON.stringify(key)}`, "xlsx");
          const hasFormula = typeof cell === "object" && cell !== null && cell.f !== undefined;
          if (hasFormula) {
            const shapes = listSheetParts(pkg).map((s) => ({ name: s.name, lastRow: 1, lastColumn: 1 }));
            const findings = lintFormula(cell.f, ref, shapes, shapes[sheet.index]);
            const hard = findings.filter((f) => f.rule === "unbalanced-syntax" || f.rule === "unknown-sheet" || f.rule === "unknown-function");
            if (hard.length > 0) {
              throw new DocumentError("corrupt", `op ${opIndex + 1} ${ref}: ${hard.map((f) => `[${f.rule}] ${f.message}`).join("; ")}`, "xlsx");
            }
            formulasTouched = true;
            result.formulasWritten++;
          }
          if (cell !== null && typeof cell === "object" && cell.fmt !== undefined) {
            throw new DocumentError("corrupt", `op ${opIndex + 1} ${ref}: changing number formats isn't supported by edit (set values and re-run create for style changes)`, "xlsx");
          }
          let rowEdit = edits.get(parsed.row);
          if (!rowEdit)
            edits.set(parsed.row, rowEdit = { row: parsed.row, replacements: new Map });
          rowEdit.replacements.set(parsed.column, { ref, cell });
        }
        const { xml: newXml, touched } = applyRowEdits(xml, [...edits.values()]);
        xml = updateDimension(newXml);
        pkg.putBytes(sheet.part, new TextEncoder().encode(xml));
        result.applied.push(`op ${opIndex + 1} set-cells: sheet ${JSON.stringify(sheet.name)}, ${Object.keys(op.cells).length} cell(s) across ${touched} row(s)`);
        break;
      }
      case "clear-range": {
        const sheet = resolveSheet(pkg, op.sheet);
        const { sheet: rangeSheet, ref } = splitSheetRef(op.range);
        if (rangeSheet !== undefined) {
          const other = resolveSheet(pkg, rangeSheet);
          if (other.name !== sheet.name)
            throw new DocumentError("corrupt", `op ${opIndex + 1}: range names ${other.name}, sheet is ${sheet.name}`, "xlsx");
        }
        const range = parseRangeRef(ref);
        if (!range)
          throw new DocumentError("corrupt", `op ${opIndex + 1}: bad range ${JSON.stringify(op.range)}`, "xlsx");
        let xml = new TextDecoder().decode(pkg.getBytes(sheet.part) ?? new Uint8Array);
        const { merges } = readGeometry(xml);
        for (const merge of merges) {
          const overlaps = merge.start.row <= range.end.row && merge.end.row >= range.start.row && merge.start.column <= range.end.column && merge.end.column >= range.start.column;
          if (overlaps) {
            throw new DocumentError("corrupt", `op ${opIndex + 1}: range ${op.range} overlaps merged cells "${columnLetter(merge.start.column)}${merge.start.row}:${columnLetter(merge.end.column)}${merge.end.row}" — unmerge manually or pick a different range`, "xlsx");
          }
        }
        const spans = scanRowSpans(xml);
        const edits = [];
        for (let r = range.start.row;r <= range.end.row; r++) {
          if (!spans.some((s) => s.row === r))
            continue;
          const replacements = new Map;
          for (let c = range.start.column;c <= range.end.column; c++) {
            replacements.set(c, { ref: `${columnLetter(c)}${r}`, cell: null });
          }
          edits.push({ row: r, replacements });
        }
        const { xml: newXml, touched } = applyRowEdits(xml, edits);
        xml = updateDimension(newXml);
        pkg.putBytes(sheet.part, new TextEncoder().encode(xml));
        result.applied.push(`op ${opIndex + 1} clear-range: sheet ${JSON.stringify(sheet.name)}, ${touched} row(s) trimmed`);
        break;
      }
      case "append-rows": {
        const sheet = resolveSheet(pkg, op.sheet);
        let xml = new TextDecoder().decode(pkg.getBytes(sheet.part) ?? new Uint8Array);
        const spans = scanRowSpans(xml);
        const lastRow = spans.length > 0 ? spans[spans.length - 1].row : 0;
        const edits = op.rows.map((cells, i) => ({
          row: lastRow + 1 + i,
          replacements: new Map(cells.map((cell, ci) => {
            const parsed = { column: ci + 1, row: lastRow + 1 + i };
            const hasFormula = typeof cell === "object" && cell !== null && cell.f !== undefined;
            if (hasFormula) {
              formulasTouched = true;
              result.formulasWritten++;
            }
            return [ci + 1, { ref: `${columnLetter(parsed.column)}${parsed.row}`, cell }];
          }))
        }));
        const { xml: newXml } = applyRowEdits(xml, edits);
        xml = updateDimension(newXml);
        pkg.putBytes(sheet.part, new TextEncoder().encode(xml));
        result.applied.push(`op ${opIndex + 1} append-rows: sheet ${JSON.stringify(sheet.name)}, ${op.rows.length} row(s) starting at ${lastRow + 1}`);
        break;
      }
      case "set-column-width": {
        const sheet = resolveSheet(pkg, op.sheet);
        let xml = new TextDecoder().decode(pkg.getBytes(sheet.part) ?? new Uint8Array);
        const newCols = new Map;
        for (const [letter, width] of Object.entries(op.columns)) {
          const col = columnIndex(letter.toUpperCase());
          if (col === undefined)
            throw new DocumentError("corrupt", `bad column letter ${JSON.stringify(letter)}`, "xlsx");
          newCols.set(col, width);
        }
        const existing = [];
        const colsMatch = /<cols>([\s\S]*?)<\/cols>/.exec(xml);
        if (colsMatch) {
          for (const m of (colsMatch[1] ?? "").matchAll(/<col\b([^>]*)\/>/g)) {
            const attrs = m[1] ?? "";
            const min = Number(/\bmin="(\d+)"/.exec(attrs)?.[1] ?? 0);
            const max = Number(/\bmax="(\d+)"/.exec(attrs)?.[1] ?? 0);
            const width = Number(/\bwidth="([\d.]+)"/.exec(attrs)?.[1] ?? 8.43);
            existing.push({ min, max, width });
          }
        }
        for (const [col, width] of newCols)
          existing.push({ min: col, max: col, width });
        const colsXml = `<cols>${existing.sort((a, b) => a.min - b.min).map((c) => `<col min="${c.min}" max="${c.max}" width="${c.width}" customWidth="1"/>`).join("")}</cols>`;
        if (colsMatch)
          xml = xml.replace(colsMatch[0], colsXml);
        else
          xml = xml.replace(/(<sheetFormatPr\b[^>]*\/>|<dimension\b[^>]*\/>)/, `$1${colsXml}`);
        pkg.putBytes(sheet.part, new TextEncoder().encode(xml));
        result.applied.push(`op ${opIndex + 1} set-column-width: sheet ${JSON.stringify(sheet.name)}, ${[...newCols.keys()].map(columnLetter).join(", ")}`);
        break;
      }
      case "add-sheet": {
        result.applied.push(addSheet(pkg, op, () => {
          formulasTouched = true;
        }));
        break;
      }
      case "fill-formula": {
        const sheet = resolveSheet(pkg, op.sheet);
        const { sheet: rangeSheet, ref } = splitSheetRef(op.range);
        if (rangeSheet !== undefined) {
          const other = resolveSheet(pkg, rangeSheet);
          if (other.name !== sheet.name)
            throw new DocumentError("corrupt", `op ${opIndex + 1}: range names ${other.name}, sheet is ${sheet.name}`, "xlsx");
        }
        let xml = new TextDecoder().decode(pkg.getBytes(sheet.part) ?? new Uint8Array);
        const range = parseRangeRef(ref);
        if (!range)
          throw new DocumentError("corrupt", `op ${opIndex + 1}: bad range ${JSON.stringify(op.range)}`, "xlsx");
        let count = 0;
        const edits = [];
        for (let r = range.start.row;r <= range.end.row; r++) {
          const replacements = new Map;
          for (let c = range.start.column;c <= range.end.column; c++) {
            const refC = `${columnLetter(c)}${r}`;
            const expanded = op.formula.replace(/\{col\}/g, columnLetter(c)).replace(/\{row\}/g, String(r));
            const cellEdit = { f: expanded };
            replacements.set(c, { ref: refC, cell: cellEdit });
            count++;
            result.formulasWritten++;
          }
          edits.push({ row: r, replacements });
        }
        const { xml: newXml } = applyRowEdits(xml, edits);
        xml = updateDimension(newXml);
        pkg.putBytes(sheet.part, new TextEncoder().encode(xml));
        formulasTouched = true;
        result.applied.push(`op ${opIndex + 1} fill-formula: sheet ${JSON.stringify(sheet.name)}, ${count} formula(s) in ${op.range}`);
        break;
      }
      default:
        throw new DocumentError("corrupt", `unknown op kind ${op.kind}`, "xlsx");
    }
  }
  if (formulasTouched) {
    removeCalcChain(pkg);
    ensureFullCalcOnLoad(pkg);
    result.formulasAlert = true;
  }
  return result;
}
function addSheet(pkg, op, onFormula) {
  const sheets = listSheetParts(pkg);
  if (sheets.some((s) => s.name.toLowerCase() === op.name.toLowerCase())) {
    throw new DocumentError("corrupt", `a sheet named ${JSON.stringify(op.name)} already exists`, "xlsx");
  }
  if (op.name.length > 31 || /[[\]:*?/\\]/.test(op.name)) {
    throw new DocumentError("corrupt", `bad sheet name ${JSON.stringify(op.name)} (forbidden chars or >31)`, "xlsx");
  }
  const newIndex = sheets.length;
  let rels = new TextDecoder().decode(pkg.getBytes("xl/_rels/workbook.xml.rels") ?? new Uint8Array);
  const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const newId = `rId${Math.max(sheets.length, 0, ...ids) + 1}`;
  const partName = `xl/worksheets/sheet${newIndex + 1}.xml`;
  rels = rels.replace(/<\/Relationships>/, `<Relationship Id="${newId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${newIndex + 1}.xml"/></Relationships>`);
  pkg.putBytes("xl/_rels/workbook.xml.rels", new TextEncoder().encode(rels));
  let wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml") ?? new Uint8Array);
  const afterIndex = op.after === undefined ? sheets.length : sheets.findIndex((s) => typeof op.after === "number" ? s.index === op.after - 1 : s.name.toLowerCase() === String(op.after).toLowerCase()) + 1;
  const newSheetTag = `<sheet name="${esc(op.name)}" sheetId="${newIndex + 1}" r:id="${newId}"/>`;
  const sheetTags = [...wb.matchAll(/<sheet\b[^>]*\/>/g)];
  if (afterIndex <= 0 || sheetTags.length === 0) {
    wb = wb.replace(/<sheets>/, `<sheets>${newSheetTag}`);
  } else if (afterIndex >= sheetTags.length) {
    const last = sheetTags[sheetTags.length - 1];
    wb = `${wb.slice(0, last.index + last[0].length)}${newSheetTag}${wb.slice(last.index + last[0].length)}`;
  } else {
    const prev = sheetTags[afterIndex - 1];
    wb = `${wb.slice(0, prev.index + prev[0].length)}${newSheetTag}${wb.slice(prev.index + prev[0].length)}`;
  }
  pkg.putBytes("xl/workbook.xml", new TextEncoder().encode(wb));
  let ct = new TextDecoder().decode(pkg.getBytes("[Content_Types].xml") ?? new Uint8Array);
  ct = ct.replace(/<\/Types>/, `<Override PartName="/xl/worksheets/sheet${newIndex + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  pkg.putBytes("[Content_Types].xml", new TextEncoder().encode(ct));
  let rowsXml = "";
  let formulas = 0;
  for (const [ri, row] of (op.rows ?? []).entries()) {
    const r = ri + 1;
    const cells = [];
    for (const [ci, cell] of row.entries()) {
      const ref = `${columnLetter(ci + 1)}${r}`;
      if (cell !== null && typeof cell === "object" && cell.f !== undefined) {
        formulas++;
        onFormula();
        cells.push(renderCell(ref, cell, ""));
      } else
        cells.push(renderCell(ref, cell, ""));
    }
    if (cells.length > 0)
      rowsXml += `<row r="${r}">${cells.join("")}</row>`;
  }
  const lastRow = (op.rows ?? []).length;
  const lastCol = Math.max(1, ...(op.rows ?? []).map((r) => r.length));
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${columnLetter(lastCol)}${Math.max(lastRow, 1)}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>${rowsXml}</sheetData></worksheet>`;
  pkg.putBytes(partName, new TextEncoder().encode(sheetXml));
  return `add-sheet: ${JSON.stringify(op.name)} at position ${Math.min(afterIndex, sheetTags.length + 1)}${formulas > 0 ? `, ${formulas} formula(s)` : ""} (op)`;
}

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/documents/paths.ts
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
var CASE_INSENSITIVE_PLATFORM = process.platform === "darwin" || process.platform === "win32";
function realPathOf(p) {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const dir = dirname(abs);
    if (dir === abs)
      return abs;
    try {
      return join(realpathSync(dir), basenameOf(abs));
    } catch {
      return abs;
    }
  }
}
function basenameOf(p) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}
function sameFile(a, b) {
  const ra = realPathOf(a);
  const rb = realPathOf(b);
  if (ra === rb)
    return true;
  if (CASE_INSENSITIVE_PLATFORM)
    return ra.toLowerCase() === rb.toLowerCase();
  return false;
}

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/documents/writers/xlsx.ts
var import_jszip2 = __toESM(require_jszip_min());
var esc2 = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function validateSpec(spec) {
  if (!Array.isArray(spec.sheets) || spec.sheets.length === 0) {
    throw new DocumentError("corrupt", "spec needs at least one sheet", "xlsx");
  }
  const seen = new Set;
  for (const sheet of spec.sheets) {
    if (typeof sheet.name !== "string" || sheet.name.trim() === "") {
      throw new DocumentError("corrupt", "every sheet needs a non-empty name", "xlsx");
    }
    if (sheet.name.length > 31) {
      throw new DocumentError("corrupt", `sheet name ${JSON.stringify(sheet.name)} exceeds 31 characters`, "xlsx");
    }
    if (/[[\]:*?/\\]/.test(sheet.name)) {
      throw new DocumentError("corrupt", `sheet name ${JSON.stringify(sheet.name)} contains a forbidden character ([ ] : * ? / \\)`, "xlsx");
    }
    const key = sheet.name.toLowerCase();
    if (seen.has(key))
      throw new DocumentError("corrupt", `duplicate sheet name ${JSON.stringify(sheet.name)}`, "xlsx");
    seen.add(key);
    if (!Array.isArray(sheet.rows))
      throw new DocumentError("corrupt", `sheet ${sheet.name}: rows must be an array`, "xlsx");
  }
}
var BUILTIN_FMT_IDS = {
  General: 0,
  "0": 1,
  "0.00": 2,
  "#,##0": 3,
  "#,##0.00": 4,
  "0%": 9,
  "0.00%": 10,
  "mm-dd-yy": 14,
  "d-mmm-yy": 15,
  "d-mmm": 16,
  "mmm-yy": 17,
  "h:mm AM/PM": 18,
  "h:mm:ss AM/PM": 19,
  "h:mm": 20,
  "h:mm:ss": 21,
  "m/d/yy h:mm": 22,
  "#,##0 ;(#,##0)": 37,
  "#,##0_);(#,##0)": 37,
  "#,##0 ;[Red](#,##0)": 38,
  "#,##0.00;(#,##0.00)": 39,
  "#,##0.00;[Red](#,##0.00)": 40,
  "mm:ss": 45,
  "[h]:mm:ss": 46,
  "mmss.0": 47,
  "##0.0E+0": 48,
  "@": 49
};
function buildStyles(codes) {
  const numFmtIds = new Map;
  let nextCustomId = 164;
  for (const code of codes) {
    if (numFmtIds.has(code))
      continue;
    numFmtIds.set(code, BUILTIN_FMT_IDS[code] ?? nextCustomId++);
  }
  const customs = codes.filter((c) => BUILTIN_FMT_IDS[c] === undefined);
  const numFmtsXml = customs.length > 0 ? `<numFmts count="${customs.length}">${customs.map((code) => `<numFmt numFmtId="${numFmtIds.get(code)}" formatCode="${esc2(code)}"/>`).join("")}</numFmts>` : "";
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    ...codes.map((code, i) => `<xf numFmtId="${numFmtIds.get(code)}" fontId="0" fillId="0" borderId="0" xfId="${i === 0 ? 1 : 1}" applyNumberFormat="1"/>`)
  ];
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${numFmtsXml}
<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
  return { stylesXml, fontIdForBold: 1, xfsCount: xfs.length, numFmtIds };
}
function sheetXml(sheet, styles, sheetIndex, shapes, lint) {
  let formulas = 0;
  const rowsXml = [];
  for (const [ri, row] of sheet.rows.entries()) {
    const r = ri + 1;
    const cells = [];
    for (const [ci, cell] of row.entries()) {
      const col = ci + 1;
      const ref = `${columnLetter(col)}${r}`;
      const written = writeCell(cell, ref, styles, lint);
      if (!written.empty)
        cells.push(written.xml);
    }
    if (cells.length > 0)
      rowsXml.push(`<row r="${r}">${cells.join("")}</row>`);
  }
  const lastRow = Math.max(shapes.lastRow, 1);
  const lastCol = columnLetter(Math.max(shapes.lastColumn, 1));
  const views = sheet.freezeHeader ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>` : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  const cols = sheet.columnWidths ? `<cols>${Object.entries(sheet.columnWidths).sort((a, b) => Number(a[0]) - Number(b[0])).map(([idx, w]) => `<col min="${idx}" max="${idx}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${lastCol}${lastRow}"/>
${views}
${cols}
<sheetData>${rowsXml.join("")}</sheetData>
</worksheet>`;
  return { xml, formulas };
}
function writeCell(cell, ref, styles, lint) {
  if (cell === null || cell === undefined)
    return { xml: "", empty: true };
  if (typeof cell === "number") {
    if (!Number.isFinite(cell))
      throw new DocumentError("corrupt", `cell ${ref}: non-finite number`, "xlsx");
    return { xml: `<c r="${ref}"><v>${cell}</v></c>`, empty: false };
  }
  if (typeof cell === "boolean")
    return { xml: `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`, empty: false };
  if (typeof cell === "string") {
    if (cell.startsWith("="))
      return formulaCell(cell.slice(1), ref, lint);
    return { xml: `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc2(cell)}</t></is></c>`, empty: false };
  }
  if (cell.f !== undefined) {
    const formula = cell.f.startsWith("=") ? cell.f.slice(1) : cell.f;
    lint(formula, ref);
    return { xml: `<c r="${ref}"><f>${esc2(applyXlfnPrefixes(formula))}</f></c>`, empty: false };
  }
  const s = cell.fmt !== undefined ? styleIndexFor(styles, String(cell.fmt), cell.bold === true) : cell.bold ? 1 : 0;
  if (cell.v !== undefined && cell.v !== null) {
    if (typeof cell.v === "number")
      return { xml: `<c r="${ref}"${s ? ` s="${s}"` : ""}><v>${cell.v}</v></c>`, empty: false };
    if (typeof cell.v === "boolean")
      return { xml: `<c r="${ref}"${s ? ` s="${s}"` : ""} t="b"><v>${cell.v ? 1 : 0}</v></c>`, empty: false };
    return {
      xml: `<c r="${ref}"${s ? ` s="${s}"` : ""} t="inlineStr"><is><t xml:space="preserve">${esc2(String(cell.v))}</t></is></c>`,
      empty: false
    };
  }
  return { xml: "", empty: true };
}
function formulaCell(formula, ref, lint) {
  lint(formula, ref);
  return { xml: `<c r="${ref}"><f>${esc2(applyXlfnPrefixes(formula))}</f></c>`, empty: false };
}
function styleIndexFor(styles, code, bold) {
  const i = [...styles.numFmtIds.keys()].indexOf(code);
  if (i < 0)
    throw new DocumentError("corrupt", `internal: style not predeclared for format ${code}`, "xlsx");
  if (bold) {
    throw new DocumentError("corrupt", `cells can be bold OR carry a number format in v1, not both (${code}) — split the style`, "xlsx");
  }
  return 2 + i;
}
async function writeXlsx(spec, options2 = {}) {
  const clock = options2.clock ?? RealClock;
  validateSpec(spec);
  const codes = [];
  const collect = (cell) => {
    if (cell !== null && typeof cell === "object" && cell.fmt !== undefined) {
      const code = String(cell.fmt);
      if (!codes.includes(code))
        codes.push(code);
    }
  };
  for (const sheet of spec.sheets)
    for (const row of sheet.rows)
      for (const cell of row)
        collect(cell);
  const styles = buildStyles(codes);
  const shapes = spec.sheets.map((sheet) => ({
    name: sheet.name,
    lastRow: sheet.rows.length,
    lastColumn: Math.max(1, ...sheet.rows.map((r) => r.length))
  }));
  const warnings = [];
  let formulas = 0;
  const parts = spec.sheets.map((sheet, i) => {
    const lint = (formula, cell) => {
      formulas++;
      const findings = lintFormula(formula, cell, shapes, shapes[i]);
      const hard = findings.filter((f) => f.rule === "unbalanced-syntax" || f.rule === "unknown-sheet" || f.rule === "unknown-function");
      if (hard.length > 0) {
        throw new DocumentError("corrupt", `formula-lint rejected ${cell} on sheet "${sheet.name}": ${hard.map((f) => `[${f.rule}] ${f.message}`).join("; ")}`, "xlsx");
      }
      for (const f of findings) {
        if (f.rule === "out-of-range-ref" || f.rule === "spill-function" || f.rule === "missing-xlfn") {
          if (f.rule !== "missing-xlfn")
            warnings.push(`${sheet.name}!${cell} (${f.rule}): ${f.message}`);
        }
      }
    };
    const { xml } = sheetXml(sheet, styles, i, shapes[i], lint);
    return xml;
  });
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${spec.sheets.map((s, i) => `<sheet name="${esc2(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const zip = new import_jszip2.default;
  const date = clock.now();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${spec.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join(`
`)}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`, { date });
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rIdMeta" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`, { date });
  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>kimchi</dc:creator>${spec.title ? `<dc:title>${esc2(spec.title)}</dc:title>` : ""}
<dcterms:created xsi:type="dcterms:W3CDTF">${date.toISOString()}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${date.toISOString()}</dcterms:modified>
</cp:coreProperties>`, { date });
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${spec.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join(`
`)}
<Relationship Id="rIdSt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, { date });
  zip.file("xl/workbook.xml", workbookXml, { date });
  zip.file("xl/styles.xml", styles.stylesXml, { date });
  for (const [i, xml] of parts.entries())
    zip.file(`xl/worksheets/sheet${i + 1}.xml`, xml, { date });
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes, warnings, formulas };
}

// ../../../../private/var/folders/sl/j50k6cnn5h1_f4sz6ktrtlw80000gn/T/kimchi-xlsx-build-CXp42V/xlsx-cli.ts
var USAGE = `usage: xlsx.mjs <command> [args]

commands:
  read <file.xlsx|file.csv> [--sheet S] [--start-row N] [--end-row N] [--max-chars N] [--show-formulas]
                                                  one sheet as a Markdown table, windowed by rows (≤50 KB/call)
  info <file.xlsx|file.xlsm>                    sheets (names, hidden state, dimensions), macros/links notes
  create <spec.json> --out <out.xlsx>           build a workbook from a JSON spec (never in place)
  edit <in.xlsx> --out <out.xlsx> --ops <ops.json>   apply ops, never in place`;
function readBytes(io, path) {
  try {
    return io(path);
  } catch (err) {
    throw new DocumentError("corrupt", `Cannot read ${path}: ${err.message}`);
  }
}
function enforceSizeCap(path, data) {
  const cap = maxFileBytes();
  if (data.length > cap) {
    throw new DocumentError("too-large", `${path} is ${(data.length / 1024 / 1024).toFixed(1)} MB, over the ${cap / 1024 / 1024} MB document cap. Raise it with KIMCHI_DOCUMENT_MAX_MB.`, "xlsx");
  }
}
function flagValue(flags, name) {
  const i = flags.indexOf(name);
  return i >= 0 ? flags[i + 1] : undefined;
}
function flagsUsed(flags) {
  return flags.filter((f) => f.startsWith("--"));
}
async function load(input, data) {
  const lower = input.toLowerCase();
  if (lower.endsWith(".csv")) {
    return extractCsv(new TextDecoder().decode(data));
  }
  if (!lower.endsWith(".xlsx") && !lower.endsWith(".xlsm")) {
    throw new DocumentError("corrupt", `expected .xlsx, .xlsm or .csv — got ${input}`, "xlsx");
  }
  return extractXlsx(data);
}
function selectSheet(selector) {
  if (selector === undefined)
    return 1;
  return /^\d+$/.test(selector) ? Number(selector) : selector;
}
async function runXlsxCli(argv, io) {
  const readFile = io.readFile ?? ((path) => new Uint8Array(readFileSync(path)));
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "read": {
        const [path, ...flags] = args;
        if (!path)
          throw new DocumentError("corrupt", "read needs a file: xlsx.mjs read <file.xlsx|file.csv> [flags]");
        const known = ["--sheet", "--start-row", "--end-row", "--max-chars", "--show-formulas"];
        for (const f of flagsUsed(flags)) {
          if (!known.includes(f))
            throw new DocumentError("corrupt", `unknown flag ${f} — options: ${known.join(", ")}`);
        }
        const data = readBytes(readFile, path);
        enforceSizeCap(path, data);
        const doc = await load(path, data);
        const parseRowFlag = (name) => {
          const v = flagValue(flags, name);
          if (v === undefined)
            return;
          const n = Number.parseInt(v, 10);
          if (!Number.isFinite(n) || n < 1)
            throw new DocumentError("corrupt", `${name} wants a positive integer, got ${v}`);
          return n;
        };
        const w = doc.window({
          sheet: selectSheet(flagValue(flags, "--sheet")),
          startRow: parseRowFlag("--start-row"),
          endRow: parseRowFlag("--end-row"),
          maxChars: parseRowFlag("--max-chars"),
          showFormulas: flags.includes("--show-formulas")
        });
        io.stdout(`# ${path} — sheet "${w.sheet}" rows ${w.fromRow}-${w.toRow}${w.truncated ? " (truncated, continue with --start-row)" : ""}

${w.markdown}`);
        for (const note of doc.notes)
          io.stderr(`note: ${note}`);
        return 0;
      }
      case "info": {
        const [path] = args;
        if (!path)
          throw new DocumentError("corrupt", "info needs a file: xlsx.mjs info <file.xlsx|file.xlsm>");
        if (args.length > 1)
          throw new DocumentError("corrupt", `info takes exactly one file (${args.slice(1).join(" ")}?)`);
        const lower = path.toLowerCase();
        if (!lower.endsWith(".xlsx") && !lower.endsWith(".xlsm")) {
          throw new DocumentError("corrupt", `info expects .xlsx/.xlsm, got ${path}`, "xlsx");
        }
        const data = readBytes(readFile, path);
        enforceSizeCap(path, data);
        const doc = await extractXlsx(data);
        const lines = [`${path} (${doc.format})`];
        for (const [i, s] of doc.sheets.entries()) {
          lines.push(`  sheet ${i + 1}: ${JSON.stringify(s.name)}${s.state !== "visible" ? ` (${s.state})` : ""} — ${s.lastRow} rows × ${s.lastColumn} columns`);
        }
        if (doc.info.date1904)
          lines.push("date system: 1904");
        if (doc.info.hasMacros)
          lines.push("macros: yes (vbaProject.bin) — preserved untouched by edits");
        if (doc.info.hasExternalLinks)
          lines.push("external links: yes — never recalculated");
        io.stdout(lines.join(`
`));
        return 0;
      }
      case "create": {
        const [specPath, ...flags] = args;
        if (!specPath)
          throw new DocumentError("corrupt", "create needs a spec: xlsx.mjs create <spec.json> --out <out.xlsx>");
        const known = ["--out", "--force"];
        for (const f of flagsUsed(flags)) {
          if (!known.includes(f))
            throw new DocumentError("corrupt", `unknown flag ${f} — options: ${known.join(", ")}`);
        }
        const out = flagValue(flags, "--out");
        if (!out)
          throw new DocumentError("corrupt", "create needs --out <out.xlsx> — never writes in place");
        if (sameFile(out, specPath))
          throw new DocumentError("corrupt", "--out must differ from the spec", "xlsx");
        if (!out.toLowerCase().endsWith(".xlsx"))
          throw new DocumentError("corrupt", `output path must end in .xlsx: ${out}`, "xlsx");
        let spec;
        try {
          spec = JSON.parse(new TextDecoder().decode(readBytes(readFile, specPath)));
        } catch {
          throw new DocumentError("corrupt", `spec is not valid JSON: ${specPath}`, "xlsx");
        }
        const { bytes, warnings, formulas } = await writeXlsx(spec, { clock: RealClock });
        const writeFile = io.writeFile ?? atomicWrite;
        writeFile(out, bytes);
        io.stdout(`created ${out} (${spec.sheets.length} sheet(s)${formulas > 0 ? `, ${formulas} formula(s)` : ""})`);
        for (const warning of warnings)
          io.stderr(`warning: ${warning}`);
        return 0;
      }
      case "edit": {
        const [input, ...flags] = args;
        if (!input)
          throw new DocumentError("corrupt", "edit needs an input: xlsx.mjs edit <in.xlsx> --out <out.xlsx> --ops <ops.json>");
        const known = ["--out", "--ops"];
        for (const f of flagsUsed(flags)) {
          if (!known.includes(f))
            throw new DocumentError("corrupt", `unknown flag ${f} — options: ${known.join(", ")}`);
        }
        const out = flagValue(flags, "--out");
        const opsPath = flagValue(flags, "--ops");
        if (!out)
          throw new DocumentError("corrupt", "edit needs --out <out.xlsx> — edits never write in place");
        if (!opsPath)
          throw new DocumentError("corrupt", "edit needs --ops <ops.json> (a JSON array of ops)");
        if (!input.toLowerCase().endsWith(".xlsx") && !input.toLowerCase().endsWith(".xlsm")) {
          throw new DocumentError("corrupt", `edit expects .xlsx/.xlsm input, got ${input}`, "xlsx");
        }
        if (!out.toLowerCase().endsWith(".xlsx") && !out.toLowerCase().endsWith(".xlsm")) {
          throw new DocumentError("corrupt", `output path must end in .xlsx/.xlsm: ${out}`, "xlsx");
        }
        if (sameFile(out, input))
          throw new DocumentError("corrupt", "--out must differ from the input — edits never write in place", "xlsx");
        const data = readBytes(readFile, input);
        enforceSizeCap(input, data);
        let raw;
        try {
          raw = JSON.parse(new TextDecoder().decode(readBytes(readFile, opsPath)));
        } catch {
          throw new DocumentError("corrupt", `ops file is not valid JSON: ${opsPath}`, "xlsx");
        }
        const ops = parseXlsxOps(raw);
        const pkg = await openOoxml(data);
        const result = applyXlsxOps(pkg, ops);
        const bytes = await pkg.save();
        const writeFile = io.writeFile ?? atomicWrite;
        writeFile(out, bytes);
        const lines = [`edited ${input} -> ${out} (${ops.length} op${ops.length === 1 ? "" : "s"} applied)`, ...result.applied];
        if (result.formulasAlert) {
          lines.push("note: formulas written without cached values — the workbook recalculates on open in Excel/LibreOffice");
        }
        if (result.macrosPreserved)
          lines.push("note: macros preserved untouched");
        io.stdout(lines.join(`
`));
        return 0;
      }
      case undefined:
      case "--help":
      case "-h":
        io.stdout(USAGE);
        return command === undefined ? 2 : 0;
      default:
        io.stderr(`unknown command "${command}"

${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (isDocumentError(err)) {
      io.stderr(`error [${err.code}]: ${err.message}`);
      return 2;
    }
    throw err;
  }
}
var OP_KINDS = ["set-cells", "clear-range", "append-rows", "set-column-width", "add-sheet", "fill-formula"];
function parseXlsxOps(raw) {
  if (!Array.isArray(raw))
    throw new DocumentError("corrupt", "ops must be a JSON array", "xlsx");
  if (raw.length === 0)
    throw new DocumentError("corrupt", "ops array is empty", "xlsx");
  return raw.map((op, i) => {
    if (op === null || typeof op !== "object")
      throw new DocumentError("corrupt", `op ${i + 1} is not an object`, "xlsx");
    const kind = op.kind;
    if (!OP_KINDS.includes(kind ?? "")) {
      throw new DocumentError("corrupt", `op ${i + 1}: unknown kind ${JSON.stringify(kind)} — allowed: ${OP_KINDS.join(", ")}`, "xlsx");
    }
    const o = op;
    const requireField = (name) => {
      if (o[name] === undefined)
        throw new DocumentError("corrupt", `op ${i + 1} (${kind}) needs "${name}"`, "xlsx");
    };
    switch (kind) {
      case "set-cells":
        requireField("cells");
        if (typeof o.cells !== "object" || o.cells === null || Array.isArray(o.cells))
          throw new DocumentError("corrupt", `op ${i + 1} (set-cells): "cells" must be an object keyed by cell ref`, "xlsx");
        break;
      case "clear-range":
        requireField("range");
        break;
      case "append-rows":
        requireField("rows");
        if (!Array.isArray(o.rows))
          throw new DocumentError("corrupt", `op ${i + 1} (append-rows): "rows" must be an array`, "xlsx");
        break;
      case "set-column-width":
        requireField("columns");
        break;
      case "add-sheet":
        requireField("name");
        break;
      case "fill-formula":
        requireField("range");
        requireField("formula");
        break;
    }
    return op;
  });
}
function atomicWrite(path, data) {
  const temp = `${path}.xlsx-mjs-tmp.${process.pid}.${++atomicWriteCounter}`;
  try {
    writeFileSync(temp, data);
  } catch (err) {
    throw new DocumentError("corrupt", `Cannot write ${path}: ${err.message}`);
  }
  try {
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {}
    throw new DocumentError("corrupt", `Cannot move output into place at ${path}: ${err.message}`);
  }
}
var atomicWriteCounter = 0;
var invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry)
    return false;
  try {
    return realpathSync2(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedAsScript) {
  runXlsxCli(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line)
  }).then((code) => {
    process.exitCode = code;
  });
}
export {
  runXlsxCli
};
