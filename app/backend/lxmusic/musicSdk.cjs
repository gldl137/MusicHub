var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/kg/vendors/infSign.min.js
var require_infSign_min = __commonJS({
  "p:/MusicHub/\u6E90\u7801/lx-music-desktop-master/src/renderer/utils/musicSdk/kg/vendors/infSign.min.js"(exports2, module2) {
    !(function(t, n) {
      "object" == typeof exports2 && "undefined" != typeof module2 ? module2.exports = n() : "function" == typeof define && define.amd ? define(n) : (t = t || self, t.infSign = n());
    })(exports2, function() {
      "use strict";
      function t(t2, n2, r2) {
        return n2 in t2 ? Object.defineProperty(t2, n2, { value: r2, enumerable: true, configurable: true, writable: true }) : t2[n2] = r2, t2;
      }
      function n(t2, n2) {
        var r2 = Object.keys(t2);
        if (Object.getOwnPropertySymbols) {
          var e2 = Object.getOwnPropertySymbols(t2);
          n2 && (e2 = e2.filter(function(n3) {
            return Object.getOwnPropertyDescriptor(t2, n3).enumerable;
          })), r2.push.apply(r2, e2);
        }
        return r2;
      }
      function r(r2) {
        for (var e2 = 1; e2 < arguments.length; e2++) {
          var o2 = null != arguments[e2] ? arguments[e2] : {};
          e2 % 2 ? n(o2, true).forEach(function(n2) {
            t(r2, n2, o2[n2]);
          }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(r2, Object.getOwnPropertyDescriptors(o2)) : n(o2).forEach(function(t2) {
            Object.defineProperty(r2, t2, Object.getOwnPropertyDescriptor(o2, t2));
          });
        }
        return r2;
      }
      function e(t2, n2) {
        return n2 = { exports: {} }, t2(n2, n2.exports), n2.exports;
      }
      function o(t2) {
        return !!t2.constructor && "function" == typeof t2.constructor.isBuffer && t2.constructor.isBuffer(t2);
      }
      function i(t2) {
        return "function" == typeof t2.readFloatLE && "function" == typeof t2.slice && o(t2.slice(0, 0));
      }
      function c() {
        var t2, n2 = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : {}, e2 = arguments.length > 1 && void 0 !== arguments[1] ? arguments[1] : "", o2 = arguments.length > 2 && void 0 !== arguments[2] ? arguments[2] : {}, i2 = false, c2 = false, a2 = "json", l2 = r({}, n2), u2 = s.isInClient();
        "function" == typeof o2 ? t2 = o2 : (t2 = o2.callback, i2 = o2.useH5 || false, a2 = o2.postType || "json", c2 = o2.isCDN || false), e2 && ("[object Object]" != Object.prototype.toString.call(e2) ? u2 = false : "urlencoded" == a2 && (u2 = false));
        var f2 = function() {
          var n3 = (/* @__PURE__ */ new Date()).getTime(), i3 = [], s2 = [], u3 = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt", f3 = { srcappid: "2919", clientver: "20000", clienttime: n3, mid: n3, uuid: n3, dfid: "-" };
          c2 && (delete f3.clienttime, delete f3.mid, delete f3.uuid, delete f3.dfid), l2 = r({}, f3, {}, l2);
          for (var g2 in l2) i3.push(g2);
          if (i3.sort(), i3.forEach(function(t3) {
            s2.push(t3 + "=" + l2[t3]);
          }), e2) if ("[object Object]" == Object.prototype.toString.call(e2)) if ("json" == a2) s2.push(JSON.stringify(e2));
          else {
            var b = [];
            for (var g2 in e2) b.push(g2 + "=" + e2[g2]);
            s2.push(b.join("&"));
          }
          else s2.push(e2);
          s2.unshift(u3), s2.push(u3), l2.signature = d(s2.join("")), o2.log && (console.log("H5\u7B7E\u540D\u524D\u53C2\u6570", s2), console.log("H5\u7B7E\u540D\u540E\u8FD4\u56DE", l2)), e2 ? t2 && t2(l2, "[object Object]" == Object.prototype.toString.call(e2) && "json" == a2 ? JSON.stringify(e2) : e2) : t2 && t2(l2);
        };
        if (u2 && !i2) {
          var g = false;
          s.mobileCall(764, { get: l2, post: e2 }, function(n3) {
            return !g && (g = true, n3 && n3.status ? (delete n3.status, o2.log && (console.log("\u5BA2\u6237\u7AEF\u7B7E\u540D\u524D\u53C2\u6570", { get: l2, post: e2 }), console.log("\u5BA2\u6237\u7AEF\u7B7E\u540D\u540E\u8FD4\u56DE", r({}, l2, {}, n3))), l2 = r({}, l2, {}, n3), e2 ? t2 && t2(l2, "[object Object]" == Object.prototype.toString.call(e2) && "json" == a2 ? JSON.stringify(e2) : e2) : t2 && t2(l2), false) : (u2 = false, void f2()));
          });
        } else u2 = false, f2();
      }
      "undefined" != typeof globalThis ? globalThis : "undefined" != typeof window ? window : "undefined" != typeof global ? global : "undefined" != typeof self && self;
      var s = e(function(t2, n2) {
        !(function(n3, r2) {
          t2.exports = (function() {
            var t3 = { str2Json: function(t4) {
              var n4 = {};
              if ("[object String]" === Object.prototype.toString.call(t4)) try {
                n4 = JSON.parse(t4);
              } catch (t5) {
                n4 = {};
              }
              return n4;
            }, json2Str: function(t4) {
              var n4 = t4;
              if ("string" != typeof t4) try {
                n4 = JSON.stringify(t4);
              } catch (t5) {
                n4 = "";
              }
              return n4;
            }, _extend: function(t4, n4) {
              if (n4) for (var r3 in t4) n4.hasOwnProperty(r3) || (n4[r3] = t4[r3]);
              return n4;
            }, formatURL: { browser: "", url: "" }, formatSong: { filename: "", filesize: "", hash: "", bitrate: "", extname: "", duration: "", mvhash: "", m4afilesize: "", "320hash": "", "320filesize": "", sqhash: "", sqfilesize: 0, feetype: 0, isfirst: 0 }, formatMV: { filename: "", singername: "", hash: "", imgurl: "" }, formatShare: { shareName: "", topicName: "", hash: "", listID: "", type: "", suid: "", slid: "", imgUrl: "", filename: "", duration: "", shareData: { linkUrl: "", picUrl: "", content: "", title: "" } }, cbNum: 0, isIOS: !!navigator.userAgent.match(/KGBrowser/gi), isKugouAndroid: !!navigator.userAgent.match(/kugouandroid/gi), isAndroid: "undefined" != typeof external && void 0 !== external.superCall, loadUrl: function(t4) {
              var n4 = document.createElement("iframe");
              n4.setAttribute("src", t4), n4.setAttribute("style", "display:none;"), n4.setAttribute("height", "0px"), n4.setAttribute("width", "0px"), n4.setAttribute("frameborder", "0"), document.body.appendChild(n4), n4.parentNode.removeChild(n4), n4 = null;
            }, callCmd: function(n4) {
              var r3 = t3;
              if (r3.isKugouAndroid) {
                var e2 = {}, o2 = "";
                if (n4.cmd && (e2.cmd = n4.cmd), n4.jsonStr && (e2.jsonStr = n4.jsonStr), n4.callback && (o2 = "kgandroidmobilecall" + ++r3.cbNum + Math.random().toString().substr(2, 9), e2.callback = o2, window[o2] = function(t4, e3) {
                  void 0 !== t4 && ("[object String]" === Object.prototype.toString.call(t4) ? (t4 = "#" === e3 ? decodeURIComponent(t4) : decodeURIComponent(decodeURIComponent(t4)), n4.callback(r3.str2Json(t4))) : n4.callback(t4));
                }), n4.AndroidCallback) {
                  var i2 = r3.str2Json(n4.jsonStr);
                  i2.AndroidCallback = o2, n4.jsonStr = r3.json2Str(i2), n4.jsonStr && (e2.jsonStr = n4.jsonStr);
                }
                var c2 = encodeURIComponent(JSON.stringify(e2)), s2 = "kugoujsbridge://start.kugou_jsbridge/?".concat(c2);
                r3.loadUrl(s2);
              } else if (r3.isAndroid) {
                var a2 = "", l2 = "";
                if (n4.jsonStr) {
                  if (n4.callback && "" !== n4.callback && true === n4.AndroidCallback) {
                    l2 = "kgmobilecall" + ++r3.cbNum + Math.random().toString().substr(2, 9), window[l2] = function(t4, e3) {
                      void 0 !== t4 && ("[object String]" === Object.prototype.toString.call(t4) ? (t4 = "#" === e3 ? decodeURIComponent(t4) : decodeURIComponent(decodeURIComponent(t4)), n4.callback(r3.str2Json(t4))) : n4.callback(t4));
                    };
                    var u2 = r3.str2Json(n4.jsonStr);
                    u2.AndroidCallback = l2, n4.jsonStr = r3.json2Str(u2);
                  }
                  try {
                    a2 = external.superCall(n4.cmd, n4.jsonStr);
                  } catch (t4) {
                  }
                } else try {
                  a2 = external.superCall(n4.cmd);
                } catch (t4) {
                }
                n4.callback && "" !== n4.callback && "AndroidCallback" != a2 && (a2 = r3.str2Json(a2), n4.callback(a2));
              } else {
                var f2 = "", d2 = "";
                n4.callback && (d2 = "kgmobilecall" + ++r3.cbNum + Math.random().toString().substr(2, 9), window[d2] = function(t4) {
                  void 0 !== t4 && n4.callback && ("[object String]" === Object.prototype.toString.call(t4) ? n4.callback(r3.str2Json(t4)) : n4.callback(t4));
                }), d2 && "" != d2 && n4.jsonStr && (f2 = 'kugouurl://start.music/?{"cmd":' + n4.cmd + ', "jsonStr":' + n4.jsonStr + ', "callback":"' + d2 + '"}'), d2 && "" != d2 && !n4.jsonStr && (f2 = 'kugouurl://start.music/?{"cmd":' + n4.cmd + ', "callback":"' + d2 + '"}'), "" == d2 && n4.jsonStr && (f2 = 'kugouurl://start.music/?{"cmd":' + n4.cmd + ', "jsonStr":' + n4.jsonStr + "}"), "" != d2 || n4.jsonStr || (f2 = 'kugouurl://start.music/?{"cmd":' + n4.cmd + "}"), r3.loadUrl(f2);
              }
            }, formartData: function(n4, r3) {
              n4 && 123 == n4 && r3 && (r3 = t3._extend(t3.formatURL, r3)), n4 && 123 == n4 && r3 && (r3 = t3._extend(t3.formatURL, r3));
            } };
            return { isIOS: t3.isIOS, isKugouAndroid: t3.isKugouAndroid, isAndroid: t3.isAndroid, isInClient: function() {
              return !(!t3.isAndroid && !t3.isKugouAndroid && !t3.isIOS);
            }, mobileCall: function(n4, r3, e2) {
              var o2 = "";
              if (r3 && (o2 = t3.json2Str(r3)), !n4) return console.error("\u8BF7\u8F93\u5165\u547D\u4EE4\u53F7\uFF01"), false;
              var i2 = {};
              n4 && (i2.cmd = n4), "" != o2 && (i2.jsonStr = o2), e2 && (i2.callback = e2), n4 && 186 == n4 && e2 && (i2.AndroidCallback = true), t3.callCmd(i2);
            }, KgWebMobileCall: function(t4, n4) {
              if (t4) try {
                var r3 = t4.split(".");
                r3.reduce(function(e2, o2) {
                  if (e2[o2]) {
                    if (o2 === r3[r3.length - 1]) {
                      var i2 = e2[o2];
                      return "function" == typeof i2 ? (e2[o2] = function(t5) {
                        i2 && i2(t5), n4 && n4(t5);
                      }, e2[o2]) : (console.error("\u8BF7\u68C0\u67E5\uFF0C\u5F53\u524D\u73AF\u5883\u53D8\u91CF\u5DF2\u6CE8\u518C\u4E86\u5BF9\u8C61\uFF1A" + t4 + "\uFF0C\u4E14\u8BE5\u5BF9\u8C61\u4E0D\u662F\u65B9\u6CD5"), null);
                    }
                    return e2[o2];
                  }
                  return o2 === r3[r3.length - 1] ? e2[o2] = function(t5) {
                    n4 && n4(t5);
                  } : e2[o2] = new Object(), e2[o2];
                }, window);
              } catch (t5) {
              }
            } };
          })();
        })();
      }), a = e(function(t2) {
        !(function() {
          var n2 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", r2 = { rotl: function(t3, n3) {
            return t3 << n3 | t3 >>> 32 - n3;
          }, rotr: function(t3, n3) {
            return t3 << 32 - n3 | t3 >>> n3;
          }, endian: function(t3) {
            if (t3.constructor == Number) return 16711935 & r2.rotl(t3, 8) | 4278255360 & r2.rotl(t3, 24);
            for (var n3 = 0; n3 < t3.length; n3++) t3[n3] = r2.endian(t3[n3]);
            return t3;
          }, randomBytes: function(t3) {
            for (var n3 = []; t3 > 0; t3--) n3.push(Math.floor(256 * Math.random()));
            return n3;
          }, bytesToWords: function(t3) {
            for (var n3 = [], r3 = 0, e2 = 0; r3 < t3.length; r3++, e2 += 8) n3[e2 >>> 5] |= t3[r3] << 24 - e2 % 32;
            return n3;
          }, wordsToBytes: function(t3) {
            for (var n3 = [], r3 = 0; r3 < 32 * t3.length; r3 += 8) n3.push(t3[r3 >>> 5] >>> 24 - r3 % 32 & 255);
            return n3;
          }, bytesToHex: function(t3) {
            for (var n3 = [], r3 = 0; r3 < t3.length; r3++) n3.push((t3[r3] >>> 4).toString(16)), n3.push((15 & t3[r3]).toString(16));
            return n3.join("");
          }, hexToBytes: function(t3) {
            for (var n3 = [], r3 = 0; r3 < t3.length; r3 += 2) n3.push(parseInt(t3.substr(r3, 2), 16));
            return n3;
          }, bytesToBase64: function(t3) {
            for (var r3 = [], e2 = 0; e2 < t3.length; e2 += 3) for (var o2 = t3[e2] << 16 | t3[e2 + 1] << 8 | t3[e2 + 2], i2 = 0; i2 < 4; i2++) 8 * e2 + 6 * i2 <= 8 * t3.length ? r3.push(n2.charAt(o2 >>> 6 * (3 - i2) & 63)) : r3.push("=");
            return r3.join("");
          }, base64ToBytes: function(t3) {
            t3 = t3.replace(/[^A-Z0-9+\/]/gi, "");
            for (var r3 = [], e2 = 0, o2 = 0; e2 < t3.length; o2 = ++e2 % 4) 0 != o2 && r3.push((n2.indexOf(t3.charAt(e2 - 1)) & Math.pow(2, -2 * o2 + 8) - 1) << 2 * o2 | n2.indexOf(t3.charAt(e2)) >>> 6 - 2 * o2);
            return r3;
          } };
          t2.exports = r2;
        })();
      }), l = { utf8: { stringToBytes: function(t2) {
        return l.bin.stringToBytes(unescape(encodeURIComponent(t2)));
      }, bytesToString: function(t2) {
        return decodeURIComponent(escape(l.bin.bytesToString(t2)));
      } }, bin: { stringToBytes: function(t2) {
        for (var n2 = [], r2 = 0; r2 < t2.length; r2++) n2.push(255 & t2.charCodeAt(r2));
        return n2;
      }, bytesToString: function(t2) {
        for (var n2 = [], r2 = 0; r2 < t2.length; r2++) n2.push(String.fromCharCode(t2[r2]));
        return n2.join("");
      } } }, u = l, f = function(t2) {
        return null != t2 && (o(t2) || i(t2) || !!t2._isBuffer);
      }, d = e(function(t2) {
        !(function() {
          var n2 = a, r2 = u.utf8, e2 = f, o2 = u.bin, i2 = function(t3, c2) {
            t3.constructor == String ? t3 = c2 && "binary" === c2.encoding ? o2.stringToBytes(t3) : r2.stringToBytes(t3) : e2(t3) ? t3 = Array.prototype.slice.call(t3, 0) : Array.isArray(t3) || (t3 = t3.toString());
            for (var s2 = n2.bytesToWords(t3), a2 = 8 * t3.length, l2 = 1732584193, u2 = -271733879, f2 = -1732584194, d2 = 271733878, g = 0; g < s2.length; g++) s2[g] = 16711935 & (s2[g] << 8 | s2[g] >>> 24) | 4278255360 & (s2[g] << 24 | s2[g] >>> 8);
            s2[a2 >>> 5] |= 128 << a2 % 32, s2[14 + (a2 + 64 >>> 9 << 4)] = a2;
            for (var b = i2._ff, p = i2._gg, h = i2._hh, m = i2._ii, g = 0; g < s2.length; g += 16) {
              var y = l2, j = u2, S = f2, v = d2;
              u2 = m(u2 = m(u2 = m(u2 = m(u2 = h(u2 = h(u2 = h(u2 = h(u2 = p(u2 = p(u2 = p(u2 = p(u2 = b(u2 = b(u2 = b(u2 = b(u2, f2 = b(f2, d2 = b(d2, l2 = b(l2, u2, f2, d2, s2[g + 0], 7, -680876936), u2, f2, s2[g + 1], 12, -389564586), l2, u2, s2[g + 2], 17, 606105819), d2, l2, s2[g + 3], 22, -1044525330), f2 = b(f2, d2 = b(d2, l2 = b(l2, u2, f2, d2, s2[g + 4], 7, -176418897), u2, f2, s2[g + 5], 12, 1200080426), l2, u2, s2[g + 6], 17, -1473231341), d2, l2, s2[g + 7], 22, -45705983), f2 = b(f2, d2 = b(d2, l2 = b(l2, u2, f2, d2, s2[g + 8], 7, 1770035416), u2, f2, s2[g + 9], 12, -1958414417), l2, u2, s2[g + 10], 17, -42063), d2, l2, s2[g + 11], 22, -1990404162), f2 = b(f2, d2 = b(d2, l2 = b(l2, u2, f2, d2, s2[g + 12], 7, 1804603682), u2, f2, s2[g + 13], 12, -40341101), l2, u2, s2[g + 14], 17, -1502002290), d2, l2, s2[g + 15], 22, 1236535329), f2 = p(f2, d2 = p(d2, l2 = p(l2, u2, f2, d2, s2[g + 1], 5, -165796510), u2, f2, s2[g + 6], 9, -1069501632), l2, u2, s2[g + 11], 14, 643717713), d2, l2, s2[g + 0], 20, -373897302), f2 = p(f2, d2 = p(d2, l2 = p(l2, u2, f2, d2, s2[g + 5], 5, -701558691), u2, f2, s2[g + 10], 9, 38016083), l2, u2, s2[g + 15], 14, -660478335), d2, l2, s2[g + 4], 20, -405537848), f2 = p(f2, d2 = p(d2, l2 = p(l2, u2, f2, d2, s2[g + 9], 5, 568446438), u2, f2, s2[g + 14], 9, -1019803690), l2, u2, s2[g + 3], 14, -187363961), d2, l2, s2[g + 8], 20, 1163531501), f2 = p(f2, d2 = p(d2, l2 = p(l2, u2, f2, d2, s2[g + 13], 5, -1444681467), u2, f2, s2[g + 2], 9, -51403784), l2, u2, s2[g + 7], 14, 1735328473), d2, l2, s2[g + 12], 20, -1926607734), f2 = h(f2, d2 = h(d2, l2 = h(l2, u2, f2, d2, s2[g + 5], 4, -378558), u2, f2, s2[g + 8], 11, -2022574463), l2, u2, s2[g + 11], 16, 1839030562), d2, l2, s2[g + 14], 23, -35309556), f2 = h(f2, d2 = h(d2, l2 = h(l2, u2, f2, d2, s2[g + 1], 4, -1530992060), u2, f2, s2[g + 4], 11, 1272893353), l2, u2, s2[g + 7], 16, -155497632), d2, l2, s2[g + 10], 23, -1094730640), f2 = h(f2, d2 = h(d2, l2 = h(l2, u2, f2, d2, s2[g + 13], 4, 681279174), u2, f2, s2[g + 0], 11, -358537222), l2, u2, s2[g + 3], 16, -722521979), d2, l2, s2[g + 6], 23, 76029189), f2 = h(f2, d2 = h(d2, l2 = h(l2, u2, f2, d2, s2[g + 9], 4, -640364487), u2, f2, s2[g + 12], 11, -421815835), l2, u2, s2[g + 15], 16, 530742520), d2, l2, s2[g + 2], 23, -995338651), f2 = m(f2, d2 = m(d2, l2 = m(l2, u2, f2, d2, s2[g + 0], 6, -198630844), u2, f2, s2[g + 7], 10, 1126891415), l2, u2, s2[g + 14], 15, -1416354905), d2, l2, s2[g + 5], 21, -57434055), f2 = m(f2, d2 = m(d2, l2 = m(l2, u2, f2, d2, s2[g + 12], 6, 1700485571), u2, f2, s2[g + 3], 10, -1894986606), l2, u2, s2[g + 10], 15, -1051523), d2, l2, s2[g + 1], 21, -2054922799), f2 = m(f2, d2 = m(d2, l2 = m(l2, u2, f2, d2, s2[g + 8], 6, 1873313359), u2, f2, s2[g + 15], 10, -30611744), l2, u2, s2[g + 6], 15, -1560198380), d2, l2, s2[g + 13], 21, 1309151649), f2 = m(f2, d2 = m(d2, l2 = m(l2, u2, f2, d2, s2[g + 4], 6, -145523070), u2, f2, s2[g + 11], 10, -1120210379), l2, u2, s2[g + 2], 15, 718787259), d2, l2, s2[g + 9], 21, -343485551), l2 = l2 + y >>> 0, u2 = u2 + j >>> 0, f2 = f2 + S >>> 0, d2 = d2 + v >>> 0;
            }
            return n2.endian([l2, u2, f2, d2]);
          };
          i2._ff = function(t3, n3, r3, e3, o3, i3, c2) {
            var s2 = t3 + (n3 & r3 | ~n3 & e3) + (o3 >>> 0) + c2;
            return (s2 << i3 | s2 >>> 32 - i3) + n3;
          }, i2._gg = function(t3, n3, r3, e3, o3, i3, c2) {
            var s2 = t3 + (n3 & e3 | r3 & ~e3) + (o3 >>> 0) + c2;
            return (s2 << i3 | s2 >>> 32 - i3) + n3;
          }, i2._hh = function(t3, n3, r3, e3, o3, i3, c2) {
            var s2 = t3 + (n3 ^ r3 ^ e3) + (o3 >>> 0) + c2;
            return (s2 << i3 | s2 >>> 32 - i3) + n3;
          }, i2._ii = function(t3, n3, r3, e3, o3, i3, c2) {
            var s2 = t3 + (r3 ^ (n3 | ~e3)) + (o3 >>> 0) + c2;
            return (s2 << i3 | s2 >>> 32 - i3) + n3;
          }, i2._blocksize = 16, i2._digestsize = 16, t2.exports = function(t3, r3) {
            if (void 0 === t3 || null === t3) throw new Error("Illegal argument " + t3);
            var e3 = n2.wordsToBytes(i2(t3, r3));
            return r3 && r3.asBytes ? e3 : r3 && r3.asString ? o2.bytesToString(e3) : n2.bytesToHex(e3);
          };
        })();
      });
      return c;
    });
  }
});

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/lx-entry.js
var lx_entry_exports = {};
__export(lx_entry_exports, {
  kgLeaderboard: () => leaderboard_default2,
  kgMusicSearch: () => musicSearch_default2,
  kgSongList: () => songList_default2,
  kwLeaderboard: () => leaderboard_default,
  kwMusicSearch: () => musicSearch_default,
  kwSongList: () => songList_default,
  mgLeaderboard: () => leaderboard_default5,
  mgMusicSearch: () => musicSearch_default5,
  mgSongList: () => songList_default5,
  txLeaderboard: () => leaderboard_default3,
  txMusicSearch: () => musicSearch_default3,
  txSongList: () => songList_default3,
  wyLeaderboard: () => leaderboard_default4,
  wyMusicSearch: () => musicSearch_default4,
  wySongList: () => songList_default4
});
module.exports = __toCommonJS(lx_entry_exports);

// p:/MusicHub/app/backend/lx/build/shims/request.js
var import_axios = __toESM(require("axios"));
var SECRET = "624868746c";
var defaultHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36"
};
function buildResp(resp) {
  let body = resp.data;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
    }
  }
  return {
    statusCode: resp.status,
    status: resp.status,
    headers: resp.headers,
    body,
    raw: resp.data
  };
}
async function fetchData(url, method, options, cancelHolder) {
  const { headers = {}, timeout = 15e3 } = options || {};
  const merged = Object.assign({}, defaultHeaders, headers);
  if (merged[SECRET] !== void 0) delete merged[SECRET];
  const cfg = {
    url,
    method: (method || "get").toUpperCase(),
    headers: merged,
    timeout,
    responseType: "text",
    validateStatus: () => true,
    maxRedirects: 5
  };
  if (options.form != null) {
    cfg.data = new URLSearchParams(options.form).toString();
    if (!cfg.headers["Content-Type"] && !cfg.headers["content-type"]) {
      cfg.headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
  } else if (options.body != null) {
    cfg.data = options.body;
  } else if (options.data != null) {
    cfg.data = options.data;
  }
  if (cancelHolder) {
    const source = import_axios.default.CancelToken.source();
    cancelHolder(source);
    cfg.cancelToken = source.token;
  }
  const resp = await import_axios.default.request(cfg);
  return buildResp(resp);
}
var httpFetch = (url, options = { method: "get" }) => {
  const obj = {
    isCancelled: false,
    cancelHttp: () => {
      obj.isCancelled = true;
      if (obj._source) {
        try {
          obj._source.cancel("canceled");
        } catch {
        }
      }
    }
  };
  obj.promise = fetchData(url, options.method || "get", options, (s) => {
    obj._source = s;
  }).catch((err) => {
    if (import_axios.default.isCancel(err)) return Promise.reject(new Error("\u5DF2\u53D6\u6D88\u8BF7\u6C42"));
    const code = err && err.code;
    if (code === "ETIMEDOUT" || code === "ECONNABORTED") return Promise.reject(new Error("\u8BF7\u6C42\u8D85\u65F6"));
    if (code === "ENOTFOUND") return Promise.reject(new Error("\u627E\u4E0D\u5230\u670D\u52A1\u5668"));
    return Promise.reject(err);
  });
  return obj;
};

// p:/MusicHub/app/backend/lx/build/shims/renderer-utils.js
var import_he = __toESM(require("he"));
var decodeName = (str = "") => {
  if (str == null) return "";
  try {
    return import_he.default.decode(String(str));
  } catch {
    return String(str);
  }
};
var numFix = (n) => n < 10 ? `0${n}` : `${n}`;
var formatPlayTime = (time) => {
  const m = Math.trunc((time || 0) / 60);
  const s = Math.trunc((time || 0) % 60);
  return m === 0 && s === 0 ? "--/--" : numFix(m) + ":" + numFix(s);
};
var sizeFormate = (size) => {
  if (!size) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const number = Math.floor(Math.log(size) / Math.log(1024));
  return `${(size / Math.pow(1024, Math.floor(number))).toFixed(2)} ${units[number]}`;
};
var toDateObj = (date) => {
  if (typeof date === "string") {
    if (/^\d+$/.test(date)) date = parseInt(date, 10);
    else {
      const d = new Date(date.replace(/-/g, "/"));
      return isNaN(d.getTime()) ? "" : d;
    }
  }
  if (typeof date === "number") {
    if (date < 1e12) date *= 1e3;
    return new Date(date);
  }
  if (date instanceof Date) return date;
  return "";
};
var dateFormat = (_date, format = "Y-M-D h:m:s") => {
  const date = toDateObj(_date);
  if (!date) return "";
  return format.replace("Y", date.getFullYear().toString()).replace("M", numFix(date.getMonth() + 1)).replace("D", numFix(date.getDate())).replace("h", numFix(date.getHours())).replace("m", numFix(date.getMinutes())).replace("s", numFix(date.getSeconds()));
};
var formatPlayCount = (num) => {
  if (num > 1e8) return `${Math.trunc(num / 1e7) / 10}\u4EBF`;
  if (num > 1e4) return `${Math.trunc(num / 1e3) / 10}\u4E07`;
  return String(num);
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/kw/util.js
var import_crypto2 = require("crypto");

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/utils.js
var import_crypto = __toESM(require("crypto"));
var toMD5 = (str) => import_crypto.default.createHash("md5").update(str).digest("hex");
var formatSingerName = (singers, nameKey = "name", join = "\u3001") => {
  if (Array.isArray(singers)) {
    const singer = [];
    singers.forEach((item) => {
      let name = item[nameKey];
      if (!name) return;
      singer.push(name);
    });
    return decodeName(singer.join(join));
  }
  return decodeName(String(singers ?? ""));
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/kw/util.js
var objStr2JSON = (str) => {
  return JSON.parse(str.replace(/('(?=(,\s*')))|('(?=:))|((?<=([:,]\s*))')|((?<={)')|('(?=}))/g, '"'));
};
var formatSinger = (rawData) => rawData.replace(/&/g, "\u3001");
var createAesEncrypt = (buffer, mode, key, iv2) => {
  const cipher = (0, import_crypto2.createCipheriv)(mode, key, iv2);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
};
var createAesDecrypt = (buffer, mode, key, iv2) => {
  const cipher = (0, import_crypto2.createDecipheriv)(mode, key, iv2);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
};
var wbdCrypto = {
  aesMode: "aes-128-ecb",
  aesKey: Buffer.from([112, 87, 39, 61, 199, 250, 41, 191, 57, 68, 45, 114, 221, 94, 140, 228], "binary"),
  aesIv: "",
  appId: "y67sprxhhpws",
  decodeData(base64Result) {
    const data = Buffer.from(decodeURIComponent(base64Result), "base64");
    return JSON.parse(createAesDecrypt(data, this.aesMode, this.aesKey, this.aesIv).toString());
  },
  createSign(data, time) {
    const str = `${this.appId}${data}${time}`;
    return toMD5(str).toUpperCase();
  },
  buildParam(jsonData) {
    const data = Buffer.from(JSON.stringify(jsonData));
    const time = Date.now();
    const encodeData = createAesEncrypt(data, this.aesMode, this.aesKey, this.aesIv).toString("base64");
    const sign = this.createSign(encodeData, time);
    return `data=${encodeURIComponent(encodeData)}&time=${time}&appId=${this.appId}&sign=${sign}`;
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/kw/leaderboard.js
var boardList = [{ id: "kw__93", name: "\u98D9\u5347\u699C", bangid: "93" }, { id: "kw__17", name: "\u65B0\u6B4C\u699C", bangid: "17" }, { id: "kw__16", name: "\u70ED\u6B4C\u699C", bangid: "16" }, { id: "kw__158", name: "\u6296\u97F3\u70ED\u6B4C\u699C", bangid: "158" }, { id: "kw__292", name: "\u94C3\u58F0\u699C", bangid: "292" }, { id: "kw__284", name: "\u70ED\u8BC4\u699C", bangid: "284" }, { id: "kw__290", name: "ACG\u65B0\u6B4C\u699C", bangid: "290" }, { id: "kw__286", name: "\u53F0\u6E7EKKBOX\u699C", bangid: "286" }, { id: "kw__279", name: "\u51AC\u65E5\u6696\u5FC3\u699C", bangid: "279" }, { id: "kw__281", name: "\u5DF4\u58EB\u968F\u8EAB\u542C\u699C", bangid: "281" }, { id: "kw__255", name: "KTV\u70B9\u5531\u699C", bangid: "255" }, { id: "kw__280", name: "\u5BB6\u52A1\u8FDB\u884C\u66F2\u699C", bangid: "280" }, { id: "kw__282", name: "\u71AC\u591C\u4FEE\u4ED9\u699C", bangid: "282" }, { id: "kw__283", name: "\u6795\u8FB9\u8F7B\u97F3\u4E50\u699C", bangid: "283" }, { id: "kw__278", name: "\u53E4\u98CE\u97F3\u4E50\u699C", bangid: "278" }, { id: "kw__264", name: "Vlog\u97F3\u4E50\u699C", bangid: "264" }, { id: "kw__242", name: "\u7535\u97F3\u699C", bangid: "242" }, { id: "kw__187", name: "\u6D41\u884C\u8D8B\u52BF\u699C", bangid: "187" }, { id: "kw__204", name: "\u73B0\u573A\u97F3\u4E50\u699C", bangid: "204" }, { id: "kw__186", name: "ACG\u795E\u66F2\u699C", bangid: "186" }, { id: "kw__185", name: "\u6700\u5F3A\u7FFB\u5531\u699C", bangid: "185" }, { id: "kw__26", name: "\u7ECF\u5178\u6000\u65E7\u699C", bangid: "26" }, { id: "kw__104", name: "\u534E\u8BED\u699C", bangid: "104" }, { id: "kw__182", name: "\u7CA4\u8BED\u699C", bangid: "182" }, { id: "kw__22", name: "\u6B27\u7F8E\u699C", bangid: "22" }, { id: "kw__184", name: "\u97E9\u8BED\u699C", bangid: "184" }, { id: "kw__183", name: "\u65E5\u8BED\u699C", bangid: "183" }, { id: "kw__145", name: "\u4F1A\u5458\u7545\u542C\u699C", bangid: "145" }, { id: "kw__153", name: "\u7F51\u7EA2\u65B0\u6B4C\u699C", bangid: "153" }, { id: "kw__64", name: "\u5F71\u89C6\u91D1\u66F2\u699C", bangid: "64" }, { id: "kw__176", name: "DJ\u55E8\u6B4C\u699C", bangid: "176" }, { id: "kw__106", name: "\u771F\u58F0\u97F3", bangid: "106" }, { id: "kw__12", name: "Billboard\u699C", bangid: "12" }, { id: "kw__49", name: "iTunes\u97F3\u4E50\u699C", bangid: "49" }, { id: "kw__180", name: "beatport\u7535\u97F3\u699C", bangid: "180" }, { id: "kw__13", name: "\u82F1\u56FDUK\u699C", bangid: "13" }, { id: "kw__164", name: "\u767E\u5927DJ\u699C", bangid: "164" }, { id: "kw__246", name: "YouTube\u97F3\u4E50\u6392\u884C\u699C", bangid: "246" }, { id: "kw__265", name: "\u97E9\u56FDGenie\u699C", bangid: "265" }, { id: "kw__14", name: "\u97E9\u56FDM-net\u699C", bangid: "14" }, { id: "kw__8", name: "\u9999\u6E2F\u7535\u53F0\u699C", bangid: "8" }, { id: "kw__15", name: "\u65E5\u672C\u516C\u4FE1\u699C", bangid: "15" }, { id: "kw__151", name: "\u817E\u8BAF\u97F3\u4E50\u4EBA\u539F\u521B\u699C", bangid: "151" }];
var sortQualityArray = (array) => {
  const qualityMap = {
    flac24bit: 4,
    flac: 3,
    "320k": 2,
    "128k": 1
  };
  const rawQualityArray = [];
  const newQualityArray = [];
  array.forEach((item, index) => {
    const type = qualityMap[item.type];
    if (!type) return;
    rawQualityArray.push({ type, index });
  });
  rawQualityArray.sort((a, b) => a.type - b.type);
  rawQualityArray.forEach((item) => {
    newQualityArray.push(array[item.index]);
  });
  return newQualityArray;
};
var leaderboard_default = {
  list: [
    {
      id: "kwbiaosb",
      name: "\u98D9\u5347\u699C",
      bangid: 93
    },
    {
      id: "kwregb",
      name: "\u70ED\u6B4C\u699C",
      bangid: 16
    },
    {
      id: "kwhuiyb",
      name: "\u4F1A\u5458\u699C",
      bangid: 145
    },
    {
      id: "kwdouyb",
      name: "\u6296\u97F3\u699C",
      bangid: 158
    },
    {
      id: "kwqsb",
      name: "\u8D8B\u52BF\u699C",
      bangid: 187
    },
    {
      id: "kwhuaijb",
      name: "\u6000\u65E7\u699C",
      bangid: 26
    },
    {
      id: "kwhuayb",
      name: "\u534E\u8BED\u699C",
      bangid: 104
    },
    {
      id: "kwyueyb",
      name: "\u7CA4\u8BED\u699C",
      bangid: 182
    },
    {
      id: "kwoumb",
      name: "\u6B27\u7F8E\u699C",
      bangid: 22
    },
    {
      id: "kwhanyb",
      name: "\u97E9\u8BED\u699C",
      bangid: 184
    },
    {
      id: "kwriyb",
      name: "\u65E5\u8BED\u699C",
      bangid: 183
    }
  ],
  // getUrl: (p, l, id) => `http://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn=${p - 1}&rn=${l}&type=bang&data=content&id=${id}&show_copyright_off=0&pcmp4=1&isbang=1`,
  regExps: {
    mInfo: /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/
  },
  limit: 100,
  _requestBoardsObj: null,
  getBoardsData() {
    if (this._requestBoardsObj) this._requestBoardsObj.cancelHttp();
    this._requestBoardsObj = httpFetch("http://qukudata.kuwo.cn/q.k?op=query&cont=tree&node=2&pn=0&rn=1000&fmt=json&level=2");
    return this._requestBoardsObj.promise;
  },
  getData(url) {
    const requestDataObj = httpFetch(url);
    return requestDataObj.promise;
  },
  filterData(rawList) {
    return rawList.map((item) => {
      let types = [];
      const _types = {};
      const qualitys = /* @__PURE__ */ new Set();
      item.n_minfo.split(";").forEach((i) => {
        const info = i.match(this.regExps.mInfo);
        if (!info) return;
        const quality = info[2];
        const size = info[4].toLocaleUpperCase();
        if (qualitys.has(quality)) return;
        qualitys.add(quality);
        switch (quality) {
          case "4000":
            types.push({ type: "flac24bit", size });
            _types.flac24bit = { size };
            break;
          case "2000":
            types.push({ type: "flac", size });
            _types.flac = { size };
            break;
          case "320":
            types.push({ type: "320k", size });
            _types["320k"] = { size };
            break;
          case "128":
            types.push({ type: "128k", size });
            _types["128k"] = { size };
            break;
        }
      });
      types = sortQualityArray(types);
      return {
        singer: formatSinger(decodeName(item.artist)),
        name: decodeName(item.name),
        albumName: decodeName(item.album),
        albumId: item.albumId,
        songmid: item.id,
        source: "kw",
        interval: formatPlayTime(parseInt(item.duration)),
        img: item.pic,
        lrc: null,
        otherSource: null,
        types,
        _types,
        typeUrl: {}
      };
    });
  },
  filterBoardsData(rawList) {
    let list = [];
    for (const board of rawList) {
      if (board.source != "1") continue;
      list.push({
        id: "kw__" + board.sourceid,
        name: board.name,
        bangid: String(board.sourceid)
      });
    }
    return list;
  },
  async getBoards(retryNum = 0) {
    this.list = boardList;
    return {
      list: boardList,
      source: "kw"
    };
  },
  getList(id, page, retryNum = 0) {
    if (++retryNum > 3) return Promise.reject(new Error("try max num"));
    const requestBody = { uid: "", devId: "", sFrom: "kuwo_sdk", user_type: "AP", carSource: "kwplayercar_ar_6.0.1.0_apk_keluze.apk", id, pn: page - 1, rn: this.limit };
    const requestUrl = `https://wbd.kuwo.cn/api/bd/bang/bang_info?${wbdCrypto.buildParam(requestBody)}`;
    const request = httpFetch(requestUrl).promise;
    return request.then(({ statusCode, body }) => {
      const rawData = wbdCrypto.decodeData(body);
      const data = rawData.data;
      if (statusCode !== 200 || rawData.code != 200 || !data.musiclist) return this.getList(id, page, retryNum);
      const total = parseInt(data.total);
      const list = this.filterData(data.musiclist);
      return {
        total,
        list,
        limit: this.limit,
        page,
        source: "kw"
      };
    });
  }
  // getDetailPageUrl(id) {
  //   return `http://www.kuwo.cn/rankList/${id}`
  // },
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/kw/album.js
var album_default = {
  limit_list: 36,
  limit_song: 1e3,
  filterListDetail(rawList, albumName, albumId) {
    return rawList.map((item, inedx) => {
      let formats = item.formats.split("|");
      let types = [];
      let _types = {};
      if (formats.includes("MP3128")) {
        types.push({ type: "128k", size: null });
        _types["128k"] = {
          size: null
        };
      }
      if (formats.includes("MP3H")) {
        types.push({ type: "320k", size: null });
        _types["320k"] = {
          size: null
        };
      }
      if (formats.includes("ALFLAC")) {
        types.push({ type: "flac", size: null });
        _types.flac = {
          size: null
        };
      }
      if (formats.includes("HIRFLAC")) {
        types.push({ type: "flac24bit", size: null });
        _types.flac24bit = {
          size: null
        };
      }
      return {
        singer: formatSinger(decodeName(item.artist)),
        name: decodeName(item.name),
        albumName,
        albumId,
        songmid: item.id,
        source: "kw",
        interval: null,
        img: item.pic,
        lrc: null,
        otherSource: null,
        types,
        _types,
        typeUrl: {}
      };
    });
  },
  /**
   * 格式化播放数量
   * @param {*} num
   */
  formatPlayCount(num) {
    if (num > 1e8) return parseInt(num / 1e7) / 10 + "\u4EBF";
    if (num > 1e4) return parseInt(num / 1e3) / 10 + "\u4E07";
    return num;
  },
  getAlbumListDetail(id, page, retryNum = 0) {
    if (retryNum > 2) return Promise.reject(new Error("try max num"));
    const requestObj_listDetail = httpFetch(`http://search.kuwo.cn/r.s?pn=${page - 1}&rn=${this.limit_song}&stype=albuminfo&albumid=${id}&show_copyright_off=0&encoding=utf&vipver=MUSIC_9.1.0`);
    return requestObj_listDetail.promise.then(({ statusCode, body }) => {
      if (statusCode !== 200) return this.getAlbumListDetail(id, page, ++retryNum);
      body = objStr2JSON(body);
      if (!body.musiclist) return this.getAlbumListDetail(id, page, ++retryNum);
      body.name = decodeName(body.name);
      return {
        list: this.filterListDetail(body.musiclist, body.name, body.albumid),
        page,
        limit: this.limit_song,
        total: parseInt(body.songnum),
        source: "kw",
        info: {
          name: body.name,
          img: body.img || body.hts_img,
          desc: decodeName(body.info),
          author: decodeName(body.artist)
          // play_count: this.formatPlayCount(body.playnum),
        }
      };
    });
  }
  // getAlbumListDetail(id, page, retryNum = 0) {
  //   if (retryNum > 2) return Promise.reject(new Error('try max num'))
  //   return tokenRequest(`http://www.kuwo.cn/api/www/album/albumInfo?albumId=${id}&pn=${page}&rn=${this.limit_song}&httpsStatus=1`).then((resp) => {
  //     return resp.promise.then(({ statusCode, body }) => {
  //       console.log(body)
  //       return Promise.reject(new Error('failed'))
  //       // if (statusCode !== 200) return this.getAlbumListDetail(id, page, ++retryNum)
  //       // const data = body.data
  //       // console.log(data)
  //       // if (!data.musicList) return this.getAlbumListDetail(id, page, ++retryNum)
  //       // return {
  //       //   list: this.filterListDetail(data.musiclist),
  //       //   page,
  //       //   limit: this.limit_song,
  //       //   total: data.total,
  //       //   source: 'kw',
  //       //   info: {
  //       //     name: data.album,
  //       //     img: data.pic,
  //       //     desc: data.albuminfo,
  //       //     author: data.artist,
  //       //     play_count: this.formatPlayCount(data.playCnt),
  //       //   },
  //       // }
  //     })
  //   })
  // },
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/kw/songList.js
var songList_default = {
  _requestObj_tags: null,
  _requestObj_hotTags: null,
  _requestObj_list: null,
  limit_list: 36,
  limit_song: 1e3,
  successCode: 200,
  sortList: [
    {
      name: "\u6700\u65B0",
      id: "new"
    },
    {
      name: "\u6700\u70ED",
      id: "hot"
    }
  ],
  regExps: {
    mInfo: /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/,
    // http://www.kuwo.cn/playlist_detail/2886046289
    // https://m.kuwo.cn/h5app/playlist/2736267853?t=qqfriend
    listDetailLink: /^.+\/playlist(?:_detail)?\/(\d+)(?:\?.*|&.*$|#.*$|$)/
  },
  tagsUrl: "http://wapi.kuwo.cn/api/pc/classify/playlist/getTagList?cmd=rcm_keyword_playlist&user=0&prod=kwplayer_pc_9.0.5.0&vipver=9.0.5.0&source=kwplayer_pc_9.0.5.0&loginUid=0&loginSid=0&appUid=76039576",
  hotTagUrl: "http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmTagList?loginUid=0&loginSid=0&appUid=76039576",
  getListUrl({ sortId, id, type, page }) {
    if (!id) return `http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?loginUid=0&loginSid=0&appUid=76039576&&pn=${page}&rn=${this.limit_list}&order=${sortId}`;
    switch (type) {
      case "10000":
        return `http://wapi.kuwo.cn/api/pc/classify/playlist/getTagPlayList?loginUid=0&loginSid=0&appUid=76039576&pn=${page}&id=${id}&rn=${this.limit_list}`;
      case "43":
        return `http://mobileinterfaces.kuwo.cn/er.s?type=get_pc_qz_data&f=web&id=${id}&prod=pc`;
    }
  },
  getListDetailUrl(id, page) {
    return `http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${id}&pn=${page - 1}&rn=${this.limit_song}&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1`;
  },
  // http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=2849349915&pn=0&rn=100&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1
  // 获取标签
  getTag(tryNum = 0) {
    if (this._requestObj_tags) this._requestObj_tags.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_tags = httpFetch(this.tagsUrl);
    return this._requestObj_tags.promise.then(({ body }) => {
      if (body.code !== this.successCode) return this.getTag(++tryNum);
      return this.filterTagInfo(body.data);
    });
  },
  // 获取标签
  getHotTag(tryNum = 0) {
    if (this._requestObj_hotTags) this._requestObj_hotTags.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_hotTags = httpFetch(this.hotTagUrl);
    return this._requestObj_hotTags.promise.then(({ body }) => {
      if (body.code !== this.successCode) return this.getHotTag(++tryNum);
      return this.filterInfoHotTag(body.data[0].data);
    });
  },
  filterInfoHotTag(rawList) {
    return rawList.map((item) => ({
      id: `${item.id}-${item.digest}`,
      name: item.name,
      source: "kw"
    }));
  },
  filterTagInfo(rawList) {
    return rawList.map((type) => ({
      name: type.name,
      list: type.data.map((item) => ({
        parent_id: type.id,
        parent_name: type.name,
        id: `${item.id}-${item.digest}`,
        name: item.name,
        source: "kw"
      }))
    }));
  },
  // 获取列表数据
  getList(sortId, tagId, page, tryNum = 0) {
    if (this._requestObj_list) this._requestObj_list.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    let id;
    let type;
    if (tagId) {
      let arr = tagId.split("-");
      id = arr[0];
      type = arr[1];
    } else {
      id = null;
    }
    this._requestObj_list = httpFetch(this.getListUrl({ sortId, id, type, page }));
    return this._requestObj_list.promise.then(({ body }) => {
      if (!id || type == "10000") {
        if (body.code !== this.successCode) return this.getList(sortId, tagId, page, ++tryNum);
        return {
          list: this.filterList(body.data.data),
          total: body.data.total,
          page: body.data.pn,
          limit: body.data.rn,
          source: "kw"
        };
      } else if (!body.length) {
        return this.getList(sortId, tagId, page, ++tryNum);
      }
      return {
        list: this.filterList2(body),
        total: 1e3,
        page,
        limit: 1e3,
        source: "kw"
      };
    });
  },
  /**
   * 格式化播放数量
   * @param {*} num
   */
  formatPlayCount(num) {
    if (num > 1e8) return parseInt(num / 1e7) / 10 + "\u4EBF";
    if (num > 1e4) return parseInt(num / 1e3) / 10 + "\u4E07";
    return num;
  },
  filterList(rawData) {
    return rawData.map((item) => ({
      play_count: this.formatPlayCount(item.listencnt),
      id: `digest-${item.digest}__${item.id}`,
      author: item.uname,
      name: item.name,
      // time: item.publish_time,
      total: item.total,
      img: item.img,
      grade: item.favorcnt / 10,
      desc: item.desc,
      source: "kw"
    }));
  },
  filterList2(rawData) {
    const list = [];
    rawData.forEach((item) => {
      if (!item.label) return;
      list.push(...item.list.map((item2) => ({
        play_count: item2.play_count && this.formatPlayCount(item2.listencnt),
        id: `digest-${item2.digest}__${item2.id}`,
        author: item2.uname,
        name: item2.name,
        total: item2.total,
        // time: item.publish_time,
        img: item2.img,
        grade: item2.favorcnt && item2.favorcnt / 10,
        desc: item2.desc,
        source: "kw"
      })));
    });
    return list;
  },
  getListDetailDigest8(id, page, tryNum = 0) {
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    const requestObj = httpFetch(this.getListDetailUrl(id, page));
    return requestObj.promise.then(({ body }) => {
      if (body.result !== "ok") return this.getListDetail(id, page, ++tryNum);
      return {
        list: this.filterListDetail(body.musiclist),
        page,
        limit: body.rn,
        total: body.total,
        source: "kw",
        info: {
          name: body.title,
          img: body.pic,
          desc: body.info,
          author: body.uname,
          play_count: this.formatPlayCount(body.playnum)
        }
      };
    });
  },
  getListDetailDigest5Info(id, tryNum = 0) {
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    const requestObj = httpFetch(`http://qukudata.kuwo.cn/q.k?op=query&cont=ninfo&node=${id}&pn=0&rn=1&fmt=json&src=mbox&level=2`);
    return requestObj.promise.then(({ statusCode, body }) => {
      if (statusCode != 200 || !body.child) return this.getListDetail(id, ++tryNum);
      return body.child.length ? body.child[0].sourceid : null;
    });
  },
  getListDetailDigest5Music(id, page, tryNum = 0) {
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    const requestObj = httpFetch(`http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${id}&pn=${page - 1}}&rn=${this.limit_song}&encode=utf-8&keyset=pl2012&identity=kuwo&pcmp4=1`);
    return requestObj.promise.then(({ body }) => {
      if (body.result !== "ok") return this.getListDetail(id, page, ++tryNum);
      return {
        list: this.filterListDetail(body.musiclist),
        page,
        limit: body.rn,
        total: body.total,
        source: "kw",
        info: {
          name: body.title,
          img: body.pic,
          desc: body.info,
          author: body.uname,
          play_count: this.formatPlayCount(body.playnum)
        }
      };
    });
  },
  async getListDetailDigest5(id, page, retryNum) {
    const detailId = await this.getListDetailDigest5Info(id, retryNum);
    return this.getListDetailDigest5Music(detailId, page, retryNum);
  },
  filterBDListDetail(rawList) {
    return rawList.map((item) => {
      var _a;
      let types = [];
      let _types = {};
      for (let info of item.audios) {
        info.size = (_a = info.size) == null ? void 0 : _a.toLocaleUpperCase();
        switch (info.bitrate) {
          case "4000":
            types.push({ type: "flac24bit", size: info.size });
            _types.flac24bit = {
              size: info.size
            };
            break;
          case "2000":
            types.push({ type: "flac", size: info.size });
            _types.flac = {
              size: info.size
            };
            break;
          case "320":
            types.push({ type: "320k", size: info.size });
            _types["320k"] = {
              size: info.size
            };
            break;
          case "128":
            types.push({ type: "128k", size: info.size });
            _types["128k"] = {
              size: info.size
            };
            break;
        }
      }
      types.reverse();
      return {
        singer: item.artists.map((s) => s.name).join("\u3001"),
        name: item.name,
        albumName: item.album,
        albumId: item.albumId,
        songmid: item.id,
        source: "kw",
        interval: formatPlayTime(item.duration),
        img: item.albumPic,
        releaseDate: item.releaseDate,
        lrc: null,
        otherSource: null,
        types,
        _types,
        typeUrl: {}
      };
    });
  },
  getReqId() {
    function t() {
      return (65536 * (1 + Math.random()) | 0).toString(16).substring(1);
    }
    return t() + t() + t() + t() + t() + t() + t() + t();
  },
  async getListDetailMusicListByBDListInfo(id, source) {
    const { body: infoData } = await httpFetch(`https://bd-api.kuwo.cn/api/service/playlist/info/${id}?reqId=${this.getReqId()}&source=${source}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36",
        plat: "h5"
      }
    }).promise.catch(() => ({ code: 0 }));
    if (infoData.code != 200) return null;
    return {
      name: infoData.data.name,
      img: infoData.data.pic,
      desc: infoData.data.description,
      author: infoData.data.creatorName,
      play_count: infoData.data.playNum
    };
  },
  async getListDetailMusicListByBDUserPub(id) {
    const { body: infoData } = await httpFetch(`https://bd-api.kuwo.cn/api/ucenter/users/pub/${id}?reqId=${this.getReqId()}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36",
        plat: "h5"
      }
    }).promise.catch(() => ({ code: 0 }));
    if (infoData.code != 200) return null;
    return {
      name: infoData.data.userInfo.nickname + "\u559C\u6B22\u7684\u97F3\u4E50",
      img: infoData.data.userInfo.headImg,
      desc: "",
      author: infoData.data.userInfo.nickname,
      play_count: ""
    };
  },
  async getListDetailMusicListByBDList(id, source, page, tryNum = 0) {
    const { body: listData } = await httpFetch(`https://bd-api.kuwo.cn/api/service/playlist/${id}/musicList?reqId=${this.getReqId()}&source=${source}&pn=${page}&rn=${this.limit_song}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36",
        plat: "h5"
      }
    }).promise.catch(() => {
      if (tryNum > 2) return Promise.reject(new Error("try max num"));
      return this.getListDetailMusicListByBDList(id, source, page, ++tryNum);
    });
    if (listData.code !== 200) return Promise.reject(new Error("failed"));
    return {
      list: this.filterBDListDetail(listData.data.list),
      page,
      limit: listData.data.pageSize,
      total: listData.data.total,
      source: "kw"
    };
  },
  async getListDetailMusicListByBD(id, page) {
    var _a, _b, _c;
    const uid = (_a = /uid=(\d+)/.exec(id)) == null ? void 0 : _a[1];
    const listId = (_b = /playlistId=(\d+)/.exec(id)) == null ? void 0 : _b[1];
    const source = (_c = /source=(\d+)/.exec(id)) == null ? void 0 : _c[1];
    if (!listId) return Promise.reject(new Error("failed"));
    const task = [this.getListDetailMusicListByBDList(listId, source, page)];
    switch (source) {
      case "4":
        task.push(this.getListDetailMusicListByBDListInfo(listId, source));
        break;
      case "5":
        task.push(this.getListDetailMusicListByBDUserPub(uid ?? listId));
        break;
    }
    const [listData, info] = await Promise.all(task);
    listData.info = info ?? {
      name: "",
      img: "",
      desc: "",
      author: "",
      play_count: ""
    };
    return listData;
  },
  // 获取歌曲列表内的音乐
  getListDetail(id, page, retryNum = 0) {
    if (/\/bodian\//.test(id)) return this.getListDetailMusicListByBD(id, page);
    if (/[?&:/]/.test(id)) id = id.replace(this.regExps.listDetailLink, "$1");
    else if (/^digest-/.test(id)) {
      let [digest, _id] = id.split("__");
      digest = digest.replace("digest-", "");
      id = _id;
      switch (digest) {
        case "8":
          break;
        case "13":
          return album_default.getAlbumListDetail(id, page, retryNum);
        case "5":
        default:
          return this.getListDetailDigest5(id, page, retryNum);
      }
    }
    return this.getListDetailDigest8(id, page, retryNum);
  },
  filterListDetail(rawData) {
    return rawData.map((item) => {
      let infoArr = item.N_MINFO.split(";");
      let types = [];
      let _types = {};
      for (let info of infoArr) {
        info = info.match(this.regExps.mInfo);
        if (info) {
          switch (info[2]) {
            case "4000":
              types.push({ type: "flac24bit", size: info[4] });
              _types.flac24bit = {
                size: info[4].toLocaleUpperCase()
              };
              break;
            case "2000":
              types.push({ type: "flac", size: info[4] });
              _types.flac = {
                size: info[4].toLocaleUpperCase()
              };
              break;
            case "320":
              types.push({ type: "320k", size: info[4] });
              _types["320k"] = {
                size: info[4].toLocaleUpperCase()
              };
              break;
            case "128":
              types.push({ type: "128k", size: info[4] });
              _types["128k"] = {
                size: info[4].toLocaleUpperCase()
              };
              break;
          }
        }
      }
      types.reverse();
      return {
        singer: formatSinger(decodeName(item.artist)),
        name: decodeName(item.name),
        albumName: decodeName(item.album),
        albumId: item.albumid,
        songmid: item.id,
        source: "kw",
        interval: formatPlayTime(parseInt(item.duration)),
        img: item.albumpic ? String(item.albumpic).replace(/\/\d+\//, "/500/").replace(/^http:/, "https:") : (item.img || item.pic || null),
        lrc: null,
        otherSource: null,
        types,
        _types,
        typeUrl: {}
      };
    });
  },
  getTags() {
    return Promise.all([this.getTag(), this.getHotTag()]).then(([tags, hotTag]) => ({ tags, hotTag, source: "kw" }));
  },
  getDetailPageUrl(id) {
    if (/[?&:/]/.test(id)) id = id.replace(this.regExps.listDetailLink, "$1");
    else if (/^digest-/.test(id)) {
      let result = id.split("__");
      id = result[1];
    }
    return `http://www.kuwo.cn/playlist_detail/${id}`;
  },
  search(text, page, limit = 20) {
    return httpFetch(`http://search.kuwo.cn/r.s?all=${encodeURIComponent(text)}&pn=${page - 1}&rn=${limit}&rformat=json&encoding=utf8&ver=mbox&vipver=MUSIC_8.7.7.0_BCS37&plat=pc&devid=28156413&ft=playlist&pay=0&needliveshow=0`).promise.then(({ body }) => {
      body = objStr2JSON(body);
      return {
        list: body.abslist.map((item) => {
          return {
            play_count: this.formatPlayCount(item.playcnt),
            id: String(item.playlistid),
            author: decodeName(item.nickname),
            name: decodeName(item.name),
            total: item.songnum,
            // time: item.publish_time,
            img: item.pic,
            desc: decodeName(item.intro),
            source: "kw"
          };
        }),
        limit,
        total: parseInt(body.TOTAL),
        source: "kw"
      };
    });
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/kw/musicSearch.js
var musicSearch_default = {
  regExps: {
    mInfo: /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/
  },
  limit: 30,
  total: 0,
  page: 0,
  allPage: 1,
  // cancelFn: null,
  musicSearch(str, page, limit) {
    const musicSearchRequestObj = httpFetch(`http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(str)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`);
    return musicSearchRequestObj.promise;
  },
  // getImg(songId) {
  //   return httpGet(`http://player.kuwo.cn/webmusic/sj/dtflagdate?flag=6&rid=MUSIC_${songId}`)
  // },
  // getLrc(songId) {
  //   return httpGet(`http://mobile.kuwo.cn/mpage/html5/songinfoandlrc?mid=${songId}&flag=0`)
  // },
  handleResult(rawData) {
    const result = [];
    if (!rawData) return result;
    for (let i = 0; i < rawData.length; i++) {
      const info = rawData[i];
      let songId = info.MUSICRID.replace("MUSIC_", "");
      if (!info.N_MINFO) {
        console.log("N_MINFO is undefined");
        return null;
      }
      const types = [];
      const _types = {};
      let infoArr = info.N_MINFO.split(";");
      for (let info2 of infoArr) {
        info2 = info2.match(this.regExps.mInfo);
        if (info2) {
          switch (info2[2]) {
            case "4000":
              types.push({ type: "flac24bit", size: info2[4] });
              _types.flac24bit = {
                size: info2[4].toLocaleUpperCase()
              };
              break;
            case "2000":
              types.push({ type: "flac", size: info2[4] });
              _types.flac = {
                size: info2[4].toLocaleUpperCase()
              };
              break;
            case "320":
              types.push({ type: "320k", size: info2[4] });
              _types["320k"] = {
                size: info2[4].toLocaleUpperCase()
              };
              break;
            case "128":
              types.push({ type: "128k", size: info2[4] });
              _types["128k"] = {
                size: info2[4].toLocaleUpperCase()
              };
              break;
          }
        }
      }
      types.reverse();
      let interval = parseInt(info.DURATION);
      result.push({
        name: decodeName(info.SONGNAME),
        singer: formatSinger(decodeName(info.ARTIST)),
        source: "kw",
        // img = (info.album.name === '' || info.album.name === '空')
        //   ? `http://player.kuwo.cn/webmusic/sj/dtflagdate?flag=6&rid=MUSIC_160911.jpg`
        //   : `https://y.gtimg.cn/music/photo_new/T002R500x500M000${info.album.mid}.jpg`
        songmid: songId,
        albumId: decodeName(info.ALBUMID || ""),
        interval: Number.isNaN(interval) ? 0 : formatPlayTime(interval),
        albumName: info.ALBUM ? decodeName(info.ALBUM) : "",
        lrc: null,
        img: info.web_albumpic_short ? "https://img1.kuwo.cn/star/albumcover/" + String(info.web_albumpic_short).replace(/^\d+\//, "500/") : (info.img || info.pic || null),
        otherSource: null,
        types,
        _types,
        typeUrl: {}
      });
    }
    return result;
  },
  search(str, page = 1, limit, retryNum = 0) {
    if (retryNum > 2) return Promise.reject(new Error("try max num"));
    if (limit == null) limit = this.limit;
    return this.musicSearch(str, page, limit).then(({ body: result }) => {
      if (!result || result.TOTAL !== "0" && result.SHOW === "0") return this.search(str, page, limit, ++retryNum);
      let list = this.handleResult(result.abslist);
      if (list == null) return this.search(str, page, limit, ++retryNum);
      this.total = parseInt(result.TOTAL);
      this.page = page;
      this.allPage = Math.ceil(this.total / limit);
      return Promise.resolve({
        list,
        allPage: this.allPage,
        total: this.total,
        limit,
        source: "kw"
      });
    });
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/kg/leaderboard.js
var boardList2 = [{ id: "kg__8888", name: "TOP500", bangid: "8888" }, { id: "kg__6666", name: "\u98D9\u5347\u699C", bangid: "6666" }, { id: "kg__59703", name: "\u8702\u9E1F\u6D41\u884C\u97F3\u4E50\u699C", bangid: "59703" }, { id: "kg__52144", name: "\u6296\u97F3\u70ED\u6B4C\u699C", bangid: "52144" }, { id: "kg__52767", name: "\u5FEB\u624B\u70ED\u6B4C\u699C", bangid: "52767" }, { id: "kg__24971", name: "DJ\u70ED\u6B4C\u699C", bangid: "24971" }, { id: "kg__23784", name: "\u7F51\u7EDC\u7EA2\u6B4C\u699C", bangid: "23784" }, { id: "kg__44412", name: "\u8BF4\u5531\u5148\u950B\u699C", bangid: "44412" }, { id: "kg__31308", name: "\u5185\u5730\u699C", bangid: "31308" }, { id: "kg__33160", name: "\u7535\u97F3\u699C", bangid: "33160" }, { id: "kg__31313", name: "\u9999\u6E2F\u5730\u533A\u699C", bangid: "31313" }, { id: "kg__51341", name: "\u6C11\u8C23\u699C", bangid: "51341" }, { id: "kg__54848", name: "\u53F0\u6E7E\u5730\u533A\u699C", bangid: "54848" }, { id: "kg__31310", name: "\u6B27\u7F8E\u699C", bangid: "31310" }, { id: "kg__33162", name: "ACG\u65B0\u6B4C\u699C", bangid: "33162" }, { id: "kg__31311", name: "\u97E9\u56FD\u699C", bangid: "31311" }, { id: "kg__31312", name: "\u65E5\u672C\u699C", bangid: "31312" }, { id: "kg__49225", name: "80\u540E\u70ED\u6B4C\u699C", bangid: "49225" }, { id: "kg__49223", name: "90\u540E\u70ED\u6B4C\u699C", bangid: "49223" }, { id: "kg__49224", name: "00\u540E\u70ED\u6B4C\u699C", bangid: "49224" }, { id: "kg__33165", name: "\u7CA4\u8BED\u91D1\u66F2\u699C", bangid: "33165" }, { id: "kg__33166", name: "\u6B27\u7F8E\u91D1\u66F2\u699C", bangid: "33166" }, { id: "kg__33163", name: "\u5F71\u89C6\u91D1\u66F2\u699C", bangid: "33163" }, { id: "kg__51340", name: "\u4F24\u611F\u699C", bangid: "51340" }, { id: "kg__35811", name: "\u4F1A\u5458\u4E13\u4EAB\u699C", bangid: "35811" }, { id: "kg__37361", name: "\u96F7\u8FBE\u699C", bangid: "37361" }, { id: "kg__21101", name: "\u5206\u4EAB\u699C", bangid: "21101" }, { id: "kg__46910", name: "\u7EFC\u827A\u65B0\u6B4C\u699C", bangid: "46910" }, { id: "kg__30972", name: "\u9177\u72D7\u97F3\u4E50\u4EBA\u539F\u521B\u699C", bangid: "30972" }, { id: "kg__60170", name: "\u95FD\u5357\u8BED\u699C", bangid: "60170" }, { id: "kg__65234", name: "\u513F\u6B4C\u699C", bangid: "65234" }, { id: "kg__4681", name: "\u7F8E\u56FDBillBoard\u699C", bangid: "4681" }, { id: "kg__25028", name: "Beatport\u7535\u5B50\u821E\u66F2\u699C", bangid: "25028" }, { id: "kg__4680", name: "\u82F1\u56FD\u5355\u66F2\u699C", bangid: "4680" }, { id: "kg__38623", name: "\u97E9\u56FDMelon\u97F3\u4E50\u699C", bangid: "38623" }, { id: "kg__42807", name: "joox\u672C\u5730\u70ED\u6B4C\u699C", bangid: "42807" }, { id: "kg__36107", name: "\u5C0F\u8BED\u79CD\u70ED\u6B4C\u699C", bangid: "36107" }, { id: "kg__4673", name: "\u65E5\u672C\u516C\u4FE1\u699C", bangid: "4673" }, { id: "kg__46868", name: "\u65E5\u672CSPACE SHOWER\u699C", bangid: "46868" }, { id: "kg__42808", name: "KKBOX\u98CE\u4E91\u699C", bangid: "42808" }, { id: "kg__60171", name: "\u8D8A\u5357\u8BED\u699C", bangid: "60171" }, { id: "kg__60172", name: "\u6CF0\u8BED\u699C", bangid: "60172" }, { id: "kg__59895", name: "R&B\u699C", bangid: "59895" }, { id: "kg__59896", name: "\u6447\u6EDA\u699C", bangid: "59896" }, { id: "kg__59897", name: "\u7235\u58EB\u699C", bangid: "59897" }, { id: "kg__59898", name: "\u4E61\u6751\u97F3\u4E50\u699C", bangid: "59898" }, { id: "kg__59900", name: "\u7EAF\u97F3\u4E50\u699C", bangid: "59900" }, { id: "kg__59899", name: "\u53E4\u5178\u699C", bangid: "59899" }, { id: "kg__22603", name: "5sing\u97F3\u4E50\u699C", bangid: "22603" }, { id: "kg__21335", name: "\u7E41\u661F\u97F3\u4E50\u699C", bangid: "21335" }, { id: "kg__33161", name: "\u53E4\u98CE\u65B0\u6B4C\u699C", bangid: "33161" }];
var leaderboard_default2 = {
  listDetailLimit: 100,
  list: [
    {
      id: "kgtop500",
      name: "TOP500",
      bangid: "8888"
    },
    {
      id: "kgwlhgb",
      name: "\u7F51\u7EDC\u699C",
      bangid: "23784"
    },
    {
      id: "kgbsb",
      name: "\u98D9\u5347\u699C",
      bangid: "6666"
    },
    {
      id: "kgfxb",
      name: "\u5206\u4EAB\u699C",
      bangid: "21101"
    },
    {
      id: "kgcyyb",
      name: "\u7EAF\u97F3\u4E50\u699C",
      bangid: "33164"
    },
    {
      id: "kggfjqb",
      name: "\u53E4\u98CE\u699C",
      bangid: "33161"
    },
    {
      id: "kgyyjqb",
      name: "\u7CA4\u8BED\u699C",
      bangid: "33165"
    },
    {
      id: "kgomjqb",
      name: "\u6B27\u7F8E\u699C",
      bangid: "33166"
    },
    {
      id: "kgdyrgb",
      name: "\u7535\u97F3\u699C",
      bangid: "33160"
    },
    {
      id: "kgjdrgb",
      name: "DJ\u70ED\u6B4C\u699C",
      bangid: "24971"
    },
    {
      id: "kghyxgb",
      name: "\u534E\u8BED\u65B0\u6B4C\u699C",
      bangid: "31308"
    }
  ],
  getUrl(p, id, limit) {
    return `http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=${limit}&area_code=1&page=${p}&rankid=${id}&with_res_tag=0&show_portrait_mv=1`;
  },
  regExps: {
    total: /total: '(\d+)',/,
    page: /page: '(\d+)',/,
    limit: /pagesize: '(\d+)',/,
    listData: /global\.features = (\[.+\]);/
  },
  _requestBoardsObj: null,
  getBoardsData() {
    if (this._requestBoardsObj) this._requestBoardsObj.cancelHttp();
    this._requestBoardsObj = httpFetch("http://mobilecdnbj.kugou.com/api/v5/rank/list?version=9108&plat=0&showtype=2&parentid=0&apiver=6&area_code=1&withsong=1");
    return this._requestBoardsObj.promise;
  },
  getData(url) {
    const requestDataObj = httpFetch(url);
    return requestDataObj.promise;
  },
  getSinger(singers) {
    let arr = [];
    singers.forEach((singer) => {
      arr.push(singer.author_name);
    });
    return arr.join("\u3001");
  },
  filterData(rawList) {
    return rawList.map((item) => {
      const types = [];
      const _types = {};
      if (item.filesize !== 0) {
        let size = sizeFormate(item.filesize);
        types.push({ type: "128k", size, hash: item.hash });
        _types["128k"] = {
          size,
          hash: item.hash
        };
      }
      if (item["320filesize"] !== 0) {
        let size = sizeFormate(item["320filesize"]);
        types.push({ type: "320k", size, hash: item["320hash"] });
        _types["320k"] = {
          size,
          hash: item["320hash"]
        };
      }
      if (item.sqfilesize !== 0) {
        let size = sizeFormate(item.sqfilesize);
        types.push({ type: "flac", size, hash: item.sqhash });
        _types.flac = {
          size,
          hash: item.sqhash
        };
      }
      if (item.filesize_high !== 0) {
        let size = sizeFormate(item.filesize_high);
        types.push({ type: "flac24bit", size, hash: item.hash_high });
        _types.flac24bit = {
          size,
          hash: item.hash_high
        };
      }
      return {
        singer: formatSingerName(item.authors, "author_name"),
        name: decodeName(item.songname),
        albumName: decodeName(item.remark),
        albumId: item.album_id,
        songmid: item.audio_id,
        source: "kg",
        interval: formatPlayTime(item.duration),
        img: (item.album_sizable_cover && String(item.album_sizable_cover).replace("{size}", 480).replace(/^http:/, "https:")) || item.img || item.album_img || (item.hash ? `https://imge.kugou.com/stdmusic/480/${item.hash}.jpg` : null),
        lrc: null,
        hash: item.hash,
        otherSource: null,
        types,
        _types,
        typeUrl: {}
      };
    });
  },
  filterBoardsData(rawList) {
    let list = [];
    for (const board of rawList) {
      if (board.isvol != 1) continue;
      list.push({
        id: "kg__" + board.rankid,
        name: board.rankname,
        bangid: String(board.rankid)
      });
    }
    return list;
  },
  async getBoards(retryNum = 0) {
    this.list = boardList2;
    return {
      list: boardList2,
      source: "kg"
    };
  },
  async getList(bangid, page, retryNum = 0) {
    if (++retryNum > 3) throw new Error("try max num");
    const { body } = await this.getData(this.getUrl(page, bangid, this.listDetailLimit));
    if (body.errcode != 0) return this.getList(bangid, page, retryNum);
    let total = body.data.total;
    let limit = 100;
    let listData = this.filterData(body.data.info);
    return {
      total,
      list: listData,
      limit,
      page,
      source: "kg"
    };
  },
  getDetailPageUrl(id) {
    if (typeof id == "string") id = id.replace("kg__", "");
    return `https://www.kugou.com/yy/rank/home/1-${id}.html`;
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/kg/songList.js
var import_infSign = __toESM(require_infSign_min());

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/kg/util.js
var signatureParams = (params, platform = "android", body = "") => {
  let keyparam = "OIlwieks28dk2k092lksi2UIkp";
  if (platform === "web") keyparam = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
  let param_list = params.split("&");
  param_list.sort();
  let sign_params = `${keyparam}${param_list.join("")}${body}${keyparam}`;
  return toMD5(sign_params);
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/kg/songList.js
var handleSignature = (id, page, limit) => new Promise((resolve, reject) => {
  (0, import_infSign.default)({ appid: 1058, type: 0, module: "playlist", page, pagesize: limit, specialid: id }, null, {
    useH5: true,
    isCDN: true,
    callback(i) {
      resolve(i.signature);
    }
  });
});
var songList_default2 = {
  _requestObj_tags: null,
  _requestObj_listInfo: null,
  _requestObj_list: null,
  _requestObj_listRecommend: null,
  listDetailLimit: 1e4,
  currentTagInfo: {
    id: void 0,
    info: void 0
  },
  sortList: [
    {
      name: "\u63A8\u8350",
      id: "5"
    },
    {
      name: "\u6700\u70ED",
      id: "6"
    },
    {
      name: "\u6700\u65B0",
      id: "7"
    },
    {
      name: "\u70ED\u85CF",
      id: "3"
    },
    {
      name: "\u98D9\u5347",
      id: "8"
    }
  ],
  cache: /* @__PURE__ */ new Map(),
  regExps: {
    listData: /global\.data = (\[.+\]);/,
    listInfo: /global = {[\s\S]+?name: "(.+)"[\s\S]+?pic: "(.+)"[\s\S]+?};/,
    // https://www.kugou.com/yy/special/single/1067062.html
    listDetailLink: /^.+\/(\d+)\.html(?:\?.*|&.*$|#.*$|$)/
  },
  // async getGlobalSpecialId(specialId) {
  //   return httpFetch(`http://mobilecdnbj.kugou.com/api/v5/special/info?specialid=${specialId}`, {
  //     headers: {
  //       'User-Agent': 'Mozilla/5.0 (Linux; Android 10; HLK-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.102 Mobile Safari/537.36 EdgA/104.0.1293.70',
  //     },
  //   }).promise.then(({ body }) => {
  //     // console.log(body)
  //     if (!body.data.global_specialid) Promise.reject(new Error('Failed to get global collection id.'))
  //     return body.data.global_specialid
  //   })
  // },
  // async getListInfoBySpecialId(special_id, retry = 0) {
  //   if (++retry > 2) throw new Error('failed')
  //   return httpFetch(`https://m.kugou.com/plist/list/${special_id}/?json=true`, {
  //     headers: {
  //       'User-Agent': 'Mozilla/5.0 (Linux; Android 10; HLK-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.5112.102 Mobile Safari/537.36 EdgA/104.0.1293.70',
  //     },
  //     follow_max: 2,
  //   }).promise.then(({ body }) => {
  //     // console.log(body)
  //     if (!body.info.list) return this.getListInfoBySpecialId(special_id, retry)
  //     let listinfo = body.info.list
  //     return {
  //       listInfo: {
  //         name: listinfo.specialname,
  //         image: listinfo.imgurl.replace('{size}', '150'),
  //         intro: listinfo.intro,
  //         author: listinfo.nickname,
  //         playcount: listinfo.playcount,
  //         total: listinfo.songcount,
  //       },
  //       globalSpecialId: listinfo.global_specialid,
  //     }
  //   })
  // },
  // async getSongListDetailByGlobalSpecialId(id, page, limit = 100, retry = 0) {
  //   if (++retry > 2) throw new Error('failed')
  //   console.log(id)
  //   const params = `specialid=0&need_sort=1&module=CloudMusic&clientver=11409&pagesize=${limit}&global_collection_id=${id}&userid=0&page=${page}&type=1&area_code=1&appid=1005`
  //   return httpFetch(`http://pubsongscdn.tx.kugou.com/v2/get_other_list_file?${params}&signature=${signatureParams(params)}`).promise.then(({ body }) => {
  //     // console.log(body)
  //     if (body.data?.info == null) return this.getSongListDetailByGlobalSpecialId(id, page, limit, retry)
  //     return body.data.info
  //   })
  // },
  parseHtmlDesc(html) {
    const prefix = '<div class="pc_specail_text pc_singer_tab_content" id="specailIntroduceWrap">';
    let index = html.indexOf(prefix);
    if (index < 0) return null;
    const afterStr = html.substring(index + prefix.length);
    index = afterStr.indexOf("</div>");
    if (index < 0) return null;
    return decodeName(afterStr.substring(0, index));
  },
  async getListDetailBySpecialId(id, page, tryNum = 0) {
    if (tryNum > 2) throw new Error("try max num");
    const { body } = await httpFetch(this.getSongListDetailUrl(id)).promise;
    let listData = body.match(this.regExps.listData);
    let listInfo = body.match(this.regExps.listInfo);
    if (!listData) return this.getListDetailBySpecialId(id, page, ++tryNum);
    let list = await this.getMusicInfos(JSON.parse(listData[1]));
    let name;
    let pic;
    if (listInfo) {
      name = listInfo[1];
      pic = listInfo[2];
    }
    let desc = this.parseHtmlDesc(body);
    return {
      list,
      page: 1,
      limit: 1e4,
      total: list.length,
      source: "kg",
      info: {
        name,
        img: pic,
        desc
        // author: body.result.info.userinfo.username,
        // play_count: formatPlayCount(body.result.listen_num),
      }
    };
  },
  getInfoUrl(tagId) {
    return tagId ? `http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1&cdn=cdn&t=5&c=${tagId}` : "http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1&";
  },
  getSongListUrl(sortId, tagId, page) {
    if (tagId == null) tagId = "";
    return `http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_ajax=1&cdn=cdn&t=${sortId}&c=${tagId}&p=${page}`;
  },
  getSongListDetailUrl(id) {
    return `http://www2.kugou.kugou.com/yueku/v9/special/single/${id}-5-9999.html`;
  },
  filterInfoHotTag(rawData) {
    const result = [];
    if (rawData.status !== 1) return result;
    for (const key of Object.keys(rawData.data)) {
      let tag = rawData.data[key];
      result.push({
        id: tag.special_id,
        name: tag.special_name,
        source: "kg"
      });
    }
    return result;
  },
  filterTagInfo(rawData) {
    const result = [];
    for (const name of Object.keys(rawData)) {
      result.push({
        name,
        list: rawData[name].data.map((tag) => ({
          parent_id: tag.parent_id,
          parent_name: tag.pname,
          id: tag.id,
          name: tag.name,
          source: "kg"
        }))
      });
    }
    return result;
  },
  getSongList(sortId, tagId, page, tryNum = 0) {
    if (this._requestObj_list) this._requestObj_list.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_list = httpFetch(
      this.getSongListUrl(sortId, tagId, page)
    );
    return this._requestObj_list.promise.then(({ body }) => {
      if (!body || body.status !== 1) return this.getSongList(sortId, tagId, page, ++tryNum);
      return this.filterList(body.special_db);
    });
  },
  getSongListRecommend(tryNum = 0) {
    if (this._requestObj_listRecommend) this._requestObj_listRecommend.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_listRecommend = httpFetch(
      "http://everydayrec.service.kugou.com/guess_special_recommend",
      {
        method: "post",
        headers: {
          "User-Agent": "KuGou2012-8275-web_browser_event_handler"
        },
        body: {
          appid: 1001,
          clienttime: 1566798337219,
          clientver: 8275,
          key: "f1f93580115bb106680d2375f8032d96",
          mid: "21511157a05844bd085308bc76ef3343",
          platform: "pc",
          userid: "262643156",
          return_min: 6,
          return_max: 15
        }
      }
    );
    return this._requestObj_listRecommend.promise.then(({ body }) => {
      if (body.status !== 1) return this.getSongListRecommend(++tryNum);
      return this.filterList(body.data.special_list);
    });
  },
  filterList(rawData) {
    return rawData.map((item) => ({
      play_count: item.total_play_count || formatPlayCount(item.play_count),
      id: "id_" + item.specialid,
      author: item.nickname,
      name: item.specialname,
      time: dateFormat(item.publish_time || item.publishtime, "Y-M-D"),
      img: item.img || item.imgurl,
      total: item.songcount,
      grade: item.grade,
      desc: item.intro,
      source: "kg"
    }));
  },
  async createHttp(url, options, retryNum = 0) {
    if (retryNum > 2) throw new Error("try max num");
    let result;
    try {
      result = await httpFetch(url, options).promise;
    } catch (err) {
      console.log(err);
      return this.createHttp(url, options, ++retryNum);
    }
    if (result.statusCode !== 200 || (result.body.error_code !== void 0 ? result.body.error_code : result.body.errcode !== void 0 ? result.body.errcode : result.body.err_code) !== 0) return this.createHttp(url, options, ++retryNum);
    if (result.body.data) return result.body.data;
    if (Array.isArray(result.body.info)) return result.body;
    return result.body.info;
  },
  createTask(hashs) {
    let data = {
      area_code: "1",
      show_privilege: 1,
      show_album_info: "1",
      is_publish: "",
      appid: 1005,
      clientver: 11451,
      mid: "1",
      dfid: "-",
      clienttime: Date.now(),
      key: "OIlwieks28dk2k092lksi2UIkp",
      fields: "album_info,author_name,audio_info,ori_audio_name,base,songname"
    };
    let list = hashs;
    let tasks = [];
    while (list.length) {
      tasks.push(Object.assign({ data: list.slice(0, 100) }, data));
      if (list.length < 100) break;
      list = list.slice(100);
    }
    let url = "http://gateway.kugou.com/v2/album_audio/audio";
    return tasks.map((task) => this.createHttp(url, {
      method: "POST",
      body: task,
      headers: {
        "KG-THash": "13a3164",
        "KG-RC": "1",
        "KG-Fake": "0",
        "KG-RF": "00869891",
        "User-Agent": "Android712-AndroidPhone-11451-376-0-FeeCacheUpdate-wifi",
        "x-router": "kmr.service.kugou.com"
      }
    }).then((data2) => data2.map((s) => s[0])));
  },
  async getMusicInfos(list) {
    return this.filterData2(
      await Promise.all(
        this.createTask(
          this.deDuplication(list).map((item) => ({ hash: item.hash }))
        )
      ).then(([...datas]) => datas.flat())
    );
  },
  async getUserListDetailByCode(id) {
    const songInfo = await this.createHttp("http://t.kugou.com/command/", {
      method: "POST",
      headers: {
        "KG-RC": 1,
        "KG-THash": "network_super_call.cpp:3676261689:379",
        "User-Agent": ""
      },
      body: { appid: 1001, clientver: 9020, mid: "21511157a05844bd085308bc76ef3343", clienttime: 640612895, key: "36164c4015e704673c588ee202b9ecb8", data: id }
    });
    let songList;
    let info = songInfo.info;
    switch (info.type) {
      case 2:
        if (!info.global_collection_id) return this.getListDetailBySpecialId(info.id);
        break;
      default:
        break;
    }
    if (info.global_collection_id) return this.getUserListDetail2(info.global_collection_id);
    if (info.userid != null) {
      songList = await this.createHttp("http://www2.kugou.kugou.com/apps/kucodeAndShare/app/", {
        method: "POST",
        headers: {
          "KG-RC": 1,
          "KG-THash": "network_super_call.cpp:3676261689:379",
          "User-Agent": ""
        },
        body: { appid: 1001, clientver: 9020, mid: "21511157a05844bd085308bc76ef3343", clienttime: 640612895, key: "36164c4015e704673c588ee202b9ecb8", data: { id: info.id, type: 3, userid: info.userid, collect_type: 0, page: 1, pagesize: info.count } }
      });
    }
    let list = await this.getMusicInfos(songList || songInfo.list);
    return {
      list,
      page: 1,
      limit: info.count,
      total: list.length,
      source: "kg",
      info: {
        name: info.name,
        img: info.img_size && info.img_size.replace("{size}", 240) || info.img,
        // desc: body.result.info.list_desc,
        author: info.username
        // play_count: formatPlayCount(info.count),
      }
    };
  },
  async getUserListDetail3(chain, page) {
    const songInfo = await this.createHttp(`http://m.kugou.com/schain/transfer?pagesize=${this.listDetailLimit}&chain=${chain}&su=1&page=${page}&n=0.7928855356604456`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1"
      }
    });
    if (!songInfo.list) {
      if (songInfo.global_collection_id) return this.getUserListDetail2(songInfo.global_collection_id);
      else return this.getUserListDetail4(songInfo, chain, page).catch(() => this.getUserListDetail5(chain));
    }
    let list = await this.getMusicInfos(songInfo.list);
    return {
      list,
      page: 1,
      limit: this.listDetailLimit,
      total: list.length,
      source: "kg",
      info: {
        name: songInfo.info.name,
        img: songInfo.info.img,
        // desc: body.result.info.list_desc,
        author: songInfo.info.username
        // play_count: formatPlayCount(info.count),
      }
    };
  },
  deDuplication(datas) {
    let ids = /* @__PURE__ */ new Set();
    return datas.filter(({ hash }) => {
      if (ids.has(hash)) return false;
      ids.add(hash);
      return true;
    });
  },
  async decodeGcid(gcid) {
    const params = "dfid=-&appid=1005&mid=0&clientver=20109&clienttime=640612895&uuid=-";
    const body = {
      ret_info: 1,
      data: [
        {
          id: gcid,
          id_type: 2
        }
      ]
    };
    const result = await this.createHttp(`https://t.kugou.com/v1/songlist/batch_decode?${params}&signature=${signatureParams(params, "android", JSON.stringify(body))}`, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; HUAWEI HMA-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.106 Mobile Safari/537.36",
        Referer: "https://m.kugou.com/"
      },
      body
    });
    return result.list[0].global_collection_id;
  },
  async getUserListDetailByLink({ info }, link) {
    let listInfo = info["0"];
    let total = listInfo.count;
    let tasks = [];
    let page = 0;
    while (total) {
      const limit = total > 90 ? 90 : total;
      total -= limit;
      page += 1;
      tasks.push(this.createHttp(link.replace(/pagesize=\d+/, "pagesize=" + limit).replace(/page=\d+/, "page=" + page), {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1",
          Referer: link
        }
      }).then((data) => data.list.info));
    }
    let result = await Promise.all(tasks).then(([...datas]) => datas.flat());
    result = await this.getMusicInfos(result);
    return {
      list: result,
      page,
      limit: this.listDetailLimit,
      total: result.length,
      source: "kg",
      info: {
        name: listInfo.name,
        img: listInfo.pic && listInfo.pic.replace("{size}", 240),
        // desc: body.result.info.list_desc,
        author: listInfo.list_create_username
        // play_count: formatPlayCount(listInfo.count),
      }
    };
  },
  createGetListDetail2Task(id, total) {
    let tasks = [];
    let page = 0;
    while (total) {
      const limit = total > 300 ? 300 : total;
      total -= limit;
      page += 1;
      const params = "appid=1058&global_specialid=" + id + "&specialid=0&plat=0&version=8000&page=" + page + "&pagesize=" + limit + "&srcappid=2919&clientver=20000&clienttime=1586163263991&mid=1586163263991&uuid=1586163263991&dfid=-";
      tasks.push(this.createHttp(`https://mobiles.kugou.com/api/v5/special/song_v2?${params}&signature=${signatureParams(params, "web")}`, {
        headers: {
          mid: "1586163263991",
          Referer: "https://m3ws.kugou.com/share/index.php",
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1",
          dfid: "-",
          clienttime: "1586163263991"
        }
      }).then((data) => data.info));
    }
    return Promise.all(tasks).then(([...datas]) => datas.flat());
  },
  async getUserListDetail2(global_collection_id) {
    let id = global_collection_id;
    if (id.length > 1e3) throw new Error("get list error");
    const params = "appid=1058&specialid=0&global_specialid=" + id + "&format=jsonp&srcappid=2919&clientver=20000&clienttime=1586163242519&mid=1586163242519&uuid=1586163242519&dfid=-";
    let info = await this.createHttp(`https://mobiles.kugou.com/api/v5/special/info_v2?${params}&signature=${signatureParams(params, "web")}`, {
      headers: {
        mid: "1586163242519",
        Referer: "https://m3ws.kugou.com/share/index.php",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1",
        dfid: "-",
        clienttime: "1586163242519"
      }
    });
    const songInfo = await this.createGetListDetail2Task(id, info.songcount);
    let list = await this.getMusicInfos(songInfo);
    return {
      list,
      page: 1,
      limit: this.listDetailLimit,
      total: list.length,
      source: "kg",
      info: {
        name: info.specialname,
        img: info.imgurl && info.imgurl.replace("{size}", 240),
        desc: info.intro,
        author: info.nickname,
        play_count: formatPlayCount(info.playcount)
      }
    };
  },
  async getListInfoByChain(chain) {
    if (this.cache.has(chain)) return this.cache.get(chain);
    const { body } = await httpFetch(`https://m.kugou.com/share/?chain=${chain}&id=${chain}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"
      }
    }).promise;
    let result = body.match(/var\sphpParam\s=\s({.+?});/);
    if (result) result = JSON.parse(result[1]);
    this.cache.set(chain, result);
    return result;
  },
  async getUserListDetailByPcChain(chain) {
    let key = `${chain}_pc_list`;
    if (this.cache.has(key)) return this.cache.get(key);
    const { body } = await httpFetch(`http://www.kugou.com/share/${chain}.html`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36"
      }
    }).promise;
    let result = body.match(/var\sdataFromSmarty\s=\s(\[.+?\])/);
    if (result) result = JSON.parse(result[1]);
    this.cache.set(chain, result);
    result = await this.getMusicInfos(result);
    return result;
  },
  async getUserListDetail4(songInfo, chain, page) {
    const limit = 100;
    const [listInfo, list] = await Promise.all([
      this.getListInfoByChain(chain),
      this.getUserListDetailById(songInfo.id, page, limit)
    ]);
    return {
      list: list || [],
      page,
      limit,
      total: list.length ?? 0,
      source: "kg",
      info: {
        name: listInfo.specialname,
        img: listInfo.imgurl && listInfo.imgurl.replace("{size}", 240),
        // desc: body.result.info.list_desc,
        author: listInfo.nickname
        // play_count: formatPlayCount(info.count),
      }
    };
  },
  async getUserListDetail5(chain) {
    const [listInfo, list] = await Promise.all([
      this.getListInfoByChain(chain),
      this.getUserListDetailByPcChain(chain)
    ]);
    return {
      list: list || [],
      page: 1,
      limit: this.listDetailLimit,
      total: list.length ?? 0,
      source: "kg",
      info: {
        name: listInfo.specialname,
        img: listInfo.imgurl && listInfo.imgurl.replace("{size}", 240),
        // desc: body.result.info.list_desc,
        author: listInfo.nickname
        // play_count: formatPlayCount(info.count),
      }
    };
  },
  async getUserListDetailById(id, page, limit) {
    const signature = await handleSignature(id, page, limit);
    let info = await this.createHttp(`https://pubsongscdn.kugou.com/v2/get_other_list_file?srcappid=2919&clientver=20000&appid=1058&type=0&module=playlist&page=${page}&pagesize=${limit}&specialid=${id}&signature=${signature}`, {
      headers: {
        Referer: "https://m3ws.kugou.com/share/index.php",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1",
        dfid: "-"
      }
    });
    let result = await this.getMusicInfos(info.info);
    return result;
  },
  async getUserListDetail(link, page, retryNum = 0) {
    var _a, _b, _c, _d, _e;
    if (retryNum > 3) return Promise.reject(new Error("link try max num"));
    if (link.includes("#")) link = link.replace(/#.*$/, "");
    if (link.includes("global_collection_id")) return this.getUserListDetail2(link.replace(/^.*?global_collection_id=(\w+)(?:&.*$|#.*$|$)/, "$1"));
    if (link.includes("gcid_")) {
      let gcid = (_a = link.match(/gcid_\w+/)) == null ? void 0 : _a[0];
      if (gcid) {
        const global_collection_id = await this.decodeGcid(gcid);
        if (global_collection_id) return this.getUserListDetail2(global_collection_id);
      }
    }
    if (link.includes("chain=")) return this.getUserListDetail3(link.replace(/^.*?chain=(\w+)(?:&.*$|#.*$|$)/, "$1"), page);
    if (link.includes(".html")) {
      if (link.includes("zlist.html")) {
        link = link.replace(/^(.*)zlist\.html/, "https://m3ws.kugou.com/zlist/list");
        if (link.includes("pagesize")) {
          link = link.replace("pagesize=30", "pagesize=" + this.listDetailLimit).replace("page=1", "page=" + page);
        } else {
          link += `&pagesize=${this.listDetailLimit}&page=${page}`;
        }
      } else if (!link.includes("song.html")) return this.getUserListDetail3(link.replace(/.+\/(\w+).html(?:\?.*|&.*$|#.*$|$)/, "$1"), page);
    }
    const requestObj_listDetailLink = httpFetch(link, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1",
        Referer: link
      }
    });
    const { headers: { location }, statusCode, body } = await requestObj_listDetailLink.promise;
    if (statusCode > 400) return this.getUserListDetail(link, page, ++retryNum);
    if (location) {
      if (location.includes("global_collection_id")) return this.getUserListDetail2(location.replace(/^.*?global_collection_id=(\w+)(?:&.*$|#.*$|$)/, "$1"));
      if (location.includes("gcid_")) {
        let gcid = (_b = link.match(/gcid_\w+/)) == null ? void 0 : _b[0];
        if (gcid) {
          const global_collection_id = await this.decodeGcid(gcid);
          if (global_collection_id) return this.getUserListDetail2(global_collection_id);
        }
      }
      if (location.includes("chain=")) return this.getUserListDetail3(location.replace(/^.*?chain=(\w+)(?:&.*$|#.*$|$)/, "$1"), page);
      if (location.includes(".html")) {
        if (location.includes("zlist.html")) {
          let link2 = location.replace(/^(.*)zlist\.html/, "https://m3ws.kugou.com/zlist/list");
          if (link2.includes("pagesize")) {
            link2 = link2.replace("pagesize=30", "pagesize=" + this.listDetailLimit).replace("page=1", "page=" + page);
          } else {
            link2 += `&pagesize=${this.listDetailLimit}&page=${page}`;
          }
          return this.getUserListDetail(link2, page, ++retryNum);
        } else return this.getUserListDetail3(location.replace(/.+\/(\w+).html(?:\?.*|&.*$|#.*$|$)/, "$1"), page);
      }
      return this.getUserListDetail(location, page, ++retryNum);
    }
    if (typeof body == "string") {
      let global_collection_id = (_c = body.match(/"global_collection_id":"(\w+)"/)) == null ? void 0 : _c[1];
      if (!global_collection_id) {
        let gcid = (_d = body.match(/"encode_gic":"(\w+)"/)) == null ? void 0 : _d[1];
        if (!gcid) gcid = (_e = body.match(/"encode_src_gid":"(\w+)"/)) == null ? void 0 : _e[1];
        if (gcid) global_collection_id = await this.decodeGcid(gcid);
      }
      if (!global_collection_id) throw new Error("get list error");
      return this.getUserListDetail2(global_collection_id);
    }
    if (body.errcode !== 0) return this.getUserListDetail(link, page, ++retryNum);
    return this.getUserListDetailByLink(body, link);
  },
  async getListDetail(id, page) {
    id = id.toString();
    if (id.includes("special/single/")) {
      id = id.replace(this.regExps.listDetailLink, "$1");
    } else if (/https?:/.test(id)) {
      return this.getUserListDetail(id.replace(/^.*?http/, "http"), page);
    } else if (/^\d+$/.test(id)) {
      return this.getUserListDetailByCode(id);
    } else if (id.startsWith("id_")) {
      id = id.replace("id_", "");
    }
    return this.getListDetailBySpecialId(id, page);
  },
  filterData(rawList) {
    return rawList.map((item) => {
      const types = [];
      const _types = {};
      if (item.filesize !== 0) {
        let size = sizeFormate(item.filesize);
        types.push({ type: "128k", size, hash: item.hash });
        _types["128k"] = {
          size,
          hash: item.hash
        };
      }
      if (item.filesize_320 !== 0) {
        let size = sizeFormate(item.filesize_320);
        types.push({ type: "320k", size, hash: item.hash_320 });
        _types["320k"] = {
          size,
          hash: item.hash_320
        };
      }
      if (item.filesize_ape !== 0) {
        let size = sizeFormate(item.filesize_ape);
        types.push({ type: "ape", size, hash: item.hash_ape });
        _types.ape = {
          size,
          hash: item.hash_ape
        };
      }
      if (item.filesize_flac !== 0) {
        let size = sizeFormate(item.filesize_flac);
        types.push({ type: "flac", size, hash: item.hash_flac });
        _types.flac = {
          size,
          hash: item.hash_flac
        };
      }
      return {
        singer: decodeName(item.singername),
        name: decodeName(item.songname),
        albumName: decodeName(item.album_name),
        albumId: item.album_id,
        songmid: item.audio_id,
        source: "kg",
        interval: formatPlayTime(item.duration / 1e3),
        img: (item.album_sizable_cover && String(item.album_sizable_cover).replace("{size}", 480).replace(/^http:/, "https:")) || (item.sizable_cover && String(item.sizable_cover).replace("{size}", 480).replace(/^http:/, "https:")) || item.img || item.album_img || (item.hash ? `https://imge.kugou.com/stdmusic/480/${item.hash}.jpg` : null),
        lrc: null,
        hash: item.hash,
        types,
        _types,
        typeUrl: {}
      };
    });
  },
  // getSinger(singers) {
  //   let arr = []
  //   singers?.forEach(singer => {
  //     arr.push(singer.name)
  //   })
  //   return arr.join('、')
  // },
  // v9 API
  // filterDatav9(rawList) {
  //   console.log(rawList)
  //   return rawList.map(item => {
  //     const types = []
  //     const _types = {}
  //     item.relate_goods.forEach(qualityObj => {
  //       if (qualityObj.level === 2) {
  //         let size = sizeFormate(qualityObj.size)
  //         types.push({ type: '128k', size, hash: qualityObj.hash })
  //         _types['128k'] = {
  //           size,
  //           hash: qualityObj.hash,
  //         }
  //       } else if (qualityObj.level === 4) {
  //         let size = sizeFormate(qualityObj.size)
  //         types.push({ type: '320k', size, hash: qualityObj.hash })
  //         _types['320k'] = {
  //           size,
  //           hash: qualityObj.hash,
  //         }
  //       } else if (qualityObj.level === 5) {
  //         let size = sizeFormate(qualityObj.size)
  //         types.push({ type: 'flac', size, hash: qualityObj.hash })
  //         _types.flac = {
  //           size,
  //           hash: qualityObj.hash,
  //         }
  //       } else if (qualityObj.level === 6) {
  //         let size = sizeFormate(qualityObj.size)
  //         types.push({ type: 'flac24bit', size, hash: qualityObj.hash })
  //         _types.flac24bit = {
  //           size,
  //           hash: qualityObj.hash,
  //         }
  //       }
  //     })
  //     const nameInfo = item.name.split(' - ')
  //     return {
  //       singer: this.getSinger(item.singerinfo),
  //       name: decodeName((nameInfo[1] ?? nameInfo[0]).trim()),
  //       albumName: decodeName(item.albuminfo.name),
  //       albumId: item.albuminfo.id,
  //       songmid: item.audio_id,
  //       source: 'kg',
  //       interval: formatPlayTime(item.timelen / 1000),
  //       img: null,
  //       lrc: null,
  //       hash: item.hash,
  //       types,
  //       _types,
  //       typeUrl: {},
  //     }
  //   })
  // },
  // hash list filter
  filterData2(rawList) {
    let ids = /* @__PURE__ */ new Set();
    let list = [];
    rawList.forEach((item) => {
      if (!item) return;
      if (ids.has(item.audio_info.audio_id)) return;
      ids.add(item.audio_info.audio_id);
      const types = [];
      const _types = {};
      if (item.audio_info.filesize !== "0") {
        let size = sizeFormate(parseInt(item.audio_info.filesize));
        types.push({ type: "128k", size, hash: item.audio_info.hash });
        _types["128k"] = {
          size,
          hash: item.audio_info.hash
        };
      }
      if (item.audio_info.filesize_320 !== "0") {
        let size = sizeFormate(parseInt(item.audio_info.filesize_320));
        types.push({ type: "320k", size, hash: item.audio_info.hash_320 });
        _types["320k"] = {
          size,
          hash: item.audio_info.hash_320
        };
      }
      if (item.audio_info.filesize_flac !== "0") {
        let size = sizeFormate(parseInt(item.audio_info.filesize_flac));
        types.push({ type: "flac", size, hash: item.audio_info.hash_flac });
        _types.flac = {
          size,
          hash: item.audio_info.hash_flac
        };
      }
      if (item.audio_info.filesize_high !== "0") {
        let size = sizeFormate(parseInt(item.audio_info.filesize_high));
        types.push({ type: "flac24bit", size, hash: item.audio_info.hash_high });
        _types.flac24bit = {
          size,
          hash: item.audio_info.hash_high
        };
      }
      list.push({
        singer: decodeName(item.author_name),
        name: decodeName(item.songname),
        albumName: decodeName(item.album_info.album_name),
        albumId: item.album_info.album_id,
        songmid: item.audio_info.audio_id,
        source: "kg",
        interval: formatPlayTime(parseInt(item.audio_info.timelength) / 1e3),
        img: (item.album_info && item.album_info.sizable_cover && String(item.album_info.sizable_cover).replace("{size}", 480).replace(/^http:/, "https:")) || item.img || (item.album_info && item.album_info.album_img) || (item.audio_info.hash ? `https://imge.kugou.com/stdmusic/480/${item.audio_info.hash}.jpg` : null),
        lrc: null,
        hash: item.audio_info.hash,
        otherSource: null,
        types,
        _types,
        typeUrl: {}
      });
    });
    return list;
  },
  // 获取列表信息
  getListInfo(tagId, tryNum = 0) {
    if (this._requestObj_listInfo) this._requestObj_listInfo.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_listInfo = httpFetch(this.getInfoUrl(tagId));
    return this._requestObj_listInfo.promise.then(({ body }) => {
      if (body.status !== 1) return this.getListInfo(tagId, ++tryNum);
      return {
        limit: body.data.params.pagesize,
        page: body.data.params.p,
        total: body.data.params.total,
        source: "kg"
      };
    });
  },
  // 获取列表数据
  getList(sortId, tagId, page) {
    let tasks = [this.getSongList(sortId, tagId, page)];
    tasks.push(
      this.currentTagInfo.id === tagId ? Promise.resolve(this.currentTagInfo.info) : this.getListInfo(tagId).then((info) => {
        this.currentTagInfo.id = tagId;
        this.currentTagInfo.info = Object.assign({}, info);
        return info;
      })
    );
    if (!tagId && page === 1 && sortId === this.sortList[0].id) tasks.push(this.getSongListRecommend());
    return Promise.all(tasks).then(([list, info, recommendList]) => {
      if (recommendList) list.unshift(...recommendList);
      return {
        list,
        ...info
      };
    });
  },
  // 获取标签
  getTags(tryNum = 0) {
    if (this._requestObj_tags) this._requestObj_tags.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_tags = httpFetch(this.getInfoUrl());
    return this._requestObj_tags.promise.then(({ body }) => {
      if (body.status !== 1) return this.getTags(++tryNum);
      return {
        hotTag: this.filterInfoHotTag(body.data.hotTag),
        tags: this.filterTagInfo(body.data.tagids),
        source: "kg"
      };
    });
  },
  getDetailPageUrl(id) {
    if (typeof id == "string") {
      if (/^https?:\/\//.test(id)) return id;
      id = id.replace("id_", "");
    }
    return `https://www.kugou.com/yy/special/single/${id}.html`;
  },
  search(text, page, limit = 20) {
    return httpFetch(`http://msearchretry.kugou.com/api/v3/search/special?keyword=${encodeURIComponent(text)}&page=${page}&pagesize=${limit}&showtype=10&filter=0&version=7910&sver=2`).promise.then(({ body }) => {
      if (body.errcode != 0) throw new Error("filed");
      return {
        list: body.data.info.map((item) => {
          return {
            play_count: formatPlayCount(item.playcount),
            id: "id_" + item.specialid,
            author: item.nickname,
            name: item.specialname,
            time: dateFormat(item.publishtime, "Y-M-D"),
            img: item.imgurl,
            grade: item.grade,
            desc: item.intro,
            total: item.songcount,
            source: "kg"
          };
        }),
        limit,
        total: body.data.total,
        source: "kg"
      };
    });
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/kg/musicSearch.js
var musicSearch_default2 = {
  limit: 30,
  total: 0,
  page: 0,
  allPage: 1,
  musicSearch(str, page, limit) {
    const searchRequest = httpFetch(`https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(str)}&page=${page}&pagesize=${limit}&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`);
    return searchRequest.promise.then(({ body }) => body);
  },
  filterData(rawData) {
    const types = [];
    const _types = {};
    if (rawData.FileSize !== 0) {
      let size = sizeFormate(rawData.FileSize);
      types.push({ type: "128k", size, hash: rawData.FileHash });
      _types["128k"] = {
        size,
        hash: rawData.FileHash
      };
    }
    if (rawData.HQFileSize !== 0) {
      let size = sizeFormate(rawData.HQFileSize);
      types.push({ type: "320k", size, hash: rawData.HQFileHash });
      _types["320k"] = {
        size,
        hash: rawData.HQFileHash
      };
    }
    if (rawData.SQFileSize !== 0) {
      let size = sizeFormate(rawData.SQFileSize);
      types.push({ type: "flac", size, hash: rawData.SQFileHash });
      _types.flac = {
        size,
        hash: rawData.SQFileHash
      };
    }
    if (rawData.ResFileSize !== 0) {
      let size = sizeFormate(rawData.ResFileSize);
      types.push({ type: "flac24bit", size, hash: rawData.ResFileHash });
      _types.flac24bit = {
        size,
        hash: rawData.ResFileHash
      };
    }
    return {
      singer: decodeName(formatSingerName(rawData.Singers, "name")),
      name: decodeName(rawData.SongName),
      albumName: decodeName(rawData.AlbumName),
      albumId: rawData.AlbumID,
      songmid: rawData.Audioid,
      source: "kg",
      interval: formatPlayTime(rawData.Duration),
      _interval: rawData.Duration,
      img: (() => { const p = rawData.AlbumImg || rawData.Image; return p ? String(p).replace("{size}", 480).replace(/^http:/, "https:") : (rawData.FileHash ? `https://imge.kugou.com/stdmusic/480/${rawData.FileHash}.jpg` : null); })(),
      lrc: null,
      otherSource: null,
      hash: rawData.FileHash,
      types,
      _types,
      typeUrl: {}
    };
  },
  handleResult(rawData) {
    let ids = /* @__PURE__ */ new Set();
    const list = [];
    rawData.forEach((item) => {
      const key = item.Audioid + item.FileHash;
      if (ids.has(key)) return;
      ids.add(key);
      list.push(this.filterData(item));
      for (const childItem of item.Grp) {
        const key2 = item.Audioid + item.FileHash;
        if (ids.has(key2)) continue;
        ids.add(key2);
        list.push(this.filterData(childItem));
      }
    });
    return list;
  },
  search(str, page = 1, limit, retryNum = 0) {
    if (++retryNum > 3) return Promise.reject(new Error("try max num"));
    if (limit == null) limit = this.limit;
    return this.musicSearch(str, page, limit).then((result) => {
      if (!result || result.error_code !== 0) return this.search(str, page, limit, retryNum);
      let list = this.handleResult(result.data.lists);
      if (list == null) return this.search(str, page, limit, retryNum);
      this.total = result.data.total;
      this.page = page;
      this.allPage = Math.ceil(this.total / limit);
      return Promise.resolve({
        list,
        allPage: this.allPage,
        limit,
        total: this.total,
        source: "kg"
      });
    });
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/tx/leaderboard.js
var boardList3 = [{ id: "tx__4", name: "\u6D41\u884C\u6307\u6570\u699C", bangid: "4" }, { id: "tx__26", name: "\u70ED\u6B4C\u699C", bangid: "26" }, { id: "tx__27", name: "\u65B0\u6B4C\u699C", bangid: "27" }, { id: "tx__62", name: "\u98D9\u5347\u699C", bangid: "62" }, { id: "tx__58", name: "\u8BF4\u5531\u699C", bangid: "58" }, { id: "tx__57", name: "\u559C\u529B\u7535\u97F3\u699C", bangid: "57" }, { id: "tx__28", name: "\u7F51\u7EDC\u6B4C\u66F2\u699C", bangid: "28" }, { id: "tx__5", name: "\u5185\u5730\u699C", bangid: "5" }, { id: "tx__3", name: "\u6B27\u7F8E\u699C", bangid: "3" }, { id: "tx__59", name: "\u9999\u6E2F\u5730\u533A\u699C", bangid: "59" }, { id: "tx__16", name: "\u97E9\u56FD\u699C", bangid: "16" }, { id: "tx__60", name: "\u6296\u5FEB\u699C", bangid: "60" }, { id: "tx__29", name: "\u5F71\u89C6\u91D1\u66F2\u699C", bangid: "29" }, { id: "tx__17", name: "\u65E5\u672C\u699C", bangid: "17" }, { id: "tx__52", name: "\u817E\u8BAF\u97F3\u4E50\u4EBA\u539F\u521B\u699C", bangid: "52" }, { id: "tx__36", name: "K\u6B4C\u91D1\u66F2\u699C", bangid: "36" }, { id: "tx__61", name: "\u53F0\u6E7E\u5730\u533A\u699C", bangid: "61" }, { id: "tx__63", name: "DJ\u821E\u66F2\u699C", bangid: "63" }, { id: "tx__64", name: "\u7EFC\u827A\u65B0\u6B4C\u699C", bangid: "64" }, { id: "tx__65", name: "\u56FD\u98CE\u70ED\u6B4C\u699C", bangid: "65" }, { id: "tx__67", name: "\u542C\u6B4C\u8BC6\u66F2\u699C", bangid: "67" }, { id: "tx__72", name: "\u52A8\u6F2B\u97F3\u4E50\u699C", bangid: "72" }, { id: "tx__73", name: "\u6E38\u620F\u97F3\u4E50\u699C", bangid: "73" }, { id: "tx__75", name: "\u6709\u58F0\u699C", bangid: "75" }, { id: "tx__131", name: "\u6821\u56ED\u97F3\u4E50\u4EBA\u6392\u884C\u699C", bangid: "131" }];
var leaderboard_default3 = {
  limit: 300,
  list: [
    {
      id: "txlxzsb",
      name: "\u6D41\u884C\u699C",
      bangid: 4
    },
    {
      id: "txrgb",
      name: "\u70ED\u6B4C\u699C",
      bangid: 26
    },
    {
      id: "txwlhgb",
      name: "\u7F51\u7EDC\u699C",
      bangid: 28
    },
    {
      id: "txdyb",
      name: "\u6296\u97F3\u699C",
      bangid: 60
    },
    {
      id: "txndb",
      name: "\u5185\u5730\u699C",
      bangid: 5
    },
    {
      id: "txxgb",
      name: "\u9999\u6E2F\u699C",
      bangid: 59
    },
    {
      id: "txtwb",
      name: "\u53F0\u6E7E\u699C",
      bangid: 61
    },
    {
      id: "txoumb",
      name: "\u6B27\u7F8E\u699C",
      bangid: 3
    },
    {
      id: "txhgb",
      name: "\u97E9\u56FD\u699C",
      bangid: 16
    },
    {
      id: "txrbb",
      name: "\u65E5\u672C\u699C",
      bangid: 17
    },
    {
      id: "txtybb",
      name: "YouTube\u699C",
      bangid: 128
    }
  ],
  listDetailRequest(id, period, limit) {
    return httpFetch("https://u.y.qq.com/cgi-bin/musicu.fcg", {
      method: "post",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)"
      },
      body: {
        toplist: {
          module: "musicToplist.ToplistInfoServer",
          method: "GetDetail",
          param: {
            topid: id,
            num: limit,
            period
          }
        },
        comm: {
          uin: 0,
          format: "json",
          ct: 20,
          cv: 1859
        }
      }
    }).promise;
  },
  regExps: {
    periodList: /<i class="play_cover__btn c_tx_link js_icon_play" data-listkey=".+?" data-listname=".+?" data-tid=".+?" data-date=".+?" .+?<\/i>/g,
    period: /data-listname="(.+?)" data-tid=".*?\/(.+?)" data-date="(.+?)" .+?<\/i>/
  },
  periods: {},
  periodUrl: "https://c.y.qq.com/node/pc/wk_v15/top.html",
  _requestBoardsObj: null,
  getBoardsData() {
    if (this._requestBoardsObj) this._requestBoardsObj.cancelHttp();
    this._requestBoardsObj = httpFetch("https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?g_tk=1928093487&inCharset=utf-8&outCharset=utf-8&notice=0&format=json&uin=0&needNewCode=1&platform=h5");
    return this._requestBoardsObj.promise;
  },
  getData(url) {
    const requestDataObj = httpFetch(url);
    return requestDataObj.promise;
  },
  filterData(rawList) {
    return rawList.map((item) => {
      var _a;
      let types = [];
      let _types = {};
      if (item.file.size_128mp3 !== 0) {
        let size = sizeFormate(item.file.size_128mp3);
        types.push({ type: "128k", size });
        _types["128k"] = {
          size
        };
      }
      if (item.file.size_320mp3 !== 0) {
        let size = sizeFormate(item.file.size_320mp3);
        types.push({ type: "320k", size });
        _types["320k"] = {
          size
        };
      }
      if (item.file.size_flac !== 0) {
        let size = sizeFormate(item.file.size_flac);
        types.push({ type: "flac", size });
        _types.flac = {
          size
        };
      }
      if (item.file.size_hires !== 0) {
        let size = sizeFormate(item.file.size_hires);
        types.push({ type: "flac24bit", size });
        _types.flac24bit = {
          size
        };
      }
      return {
        singer: formatSingerName(item.singer, "name"),
        name: item.title,
        albumName: item.album.name,
        albumId: item.album.mid,
        source: "tx",
        interval: formatPlayTime(item.interval),
        songId: item.id,
        albumMid: item.album.mid,
        strMediaMid: item.file.media_mid,
        songmid: item.mid,
        img: item.album.name === "" || item.album.name === "\u7A7A" ? ((_a = item.singer) == null ? void 0 : _a.length) ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg` : "" : `https://y.gtimg.cn/music/photo_new/T002R500x500M000${item.album.mid}.jpg`,
        lrc: null,
        otherSource: null,
        types,
        _types,
        typeUrl: {}
      };
    });
  },
  getPeriods(bangid) {
    return this.getData(this.periodUrl).then(({ body: html }) => {
      let result = html.match(this.regExps.periodList);
      if (!result) return Promise.reject(new Error("get data failed"));
      result.forEach((item) => {
        let result2 = item.match(this.regExps.period);
        if (!result2) return;
        this.periods[result2[2]] = {
          name: result2[1],
          bangid: result2[2],
          period: result2[3]
        };
      });
      const info = this.periods[bangid];
      return info && info.period;
    });
  },
  filterBoardsData(rawList) {
    let list = [];
    for (const board of rawList) {
      if (board.id == 201) continue;
      if (board.topTitle.startsWith("\u5DC5\u5CF0\u699C\xB7")) {
        board.topTitle = board.topTitle.substring(4, board.topTitle.length);
      }
      if (!board.topTitle.endsWith("\u699C")) board.topTitle += "\u699C";
      list.push({
        id: "tx__" + board.id,
        name: board.topTitle,
        bangid: String(board.id)
      });
    }
    return list;
  },
  async getBoards(retryNum = 0) {
    this.list = boardList3;
    return {
      list: boardList3,
      source: "tx"
    };
  },
  getList(bangid, page, retryNum = 0) {
    if (++retryNum > 3) return Promise.reject(new Error("try max num"));
    bangid = parseInt(bangid);
    let info = this.periods[bangid];
    let p = info ? Promise.resolve(info.period) : this.getPeriods(bangid);
    return p.then((period) => {
      return this.listDetailRequest(bangid, period, this.limit).then((resp) => {
        if (resp.body.code !== 0) return this.getList(bangid, page, retryNum);
        return {
          total: resp.body.toplist.data.songInfoList.length,
          list: this.filterData(resp.body.toplist.data.songInfoList),
          limit: this.limit,
          page: 1,
          source: "tx"
        };
      });
    });
  },
  getDetailPageUrl(id) {
    if (typeof id == "string") id = id.replace("tx__", "");
    return `https://y.qq.com/n/ryqq/toplist/${id}`;
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/tx/songList.js
var songList_default3 = {
  _requestObj_tags: null,
  _requestObj_hotTags: null,
  _requestObj_list: null,
  limit_list: 36,
  limit_song: 1e5,
  successCode: 0,
  sortList: [
    {
      name: "\u6700\u70ED",
      id: 5
    },
    {
      name: "\u6700\u65B0",
      id: 2
    }
  ],
  regExps: {
    hotTagHtml: /class="c_bg_link js_tag_item" data-id="\w+">.+?<\/a>/g,
    hotTag: /data-id="(\w+)">(.+?)<\/a>/,
    // https://y.qq.com/n/yqq/playlist/7217720898.html
    // https://i.y.qq.com/n2/m/share/details/taoge.html?platform=11&appshare=android_qq&appversion=9050006&id=7217720898&ADTAG=qfshare
    listDetailLink: /\/playlist\/(\d+)/,
    listDetailLink2: /id=(\d+)/
  },
  tagsUrl: "https://u.y.qq.com/cgi-bin/musicu.fcg?loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0&data=%7B%22tags%22%3A%7B%22method%22%3A%22get_all_categories%22%2C%22param%22%3A%7B%22qq%22%3A%22%22%7D%2C%22module%22%3A%22playlist.PlaylistAllCategoriesServer%22%7D%7D",
  hotTagUrl: "https://c.y.qq.com/node/pc/wk_v15/category_playlist.html",
  getListUrl(sortId, id, page) {
    if (id) {
      id = parseInt(id);
      return `https://u.y.qq.com/cgi-bin/musicu.fcg?loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0&data=${encodeURIComponent(JSON.stringify({
        comm: { cv: 1602, ct: 20 },
        playlist: {
          method: "get_category_content",
          param: {
            titleid: id,
            caller: "0",
            category_id: id,
            size: this.limit_list,
            page: page - 1,
            use_page: 1
          },
          module: "playlist.PlayListCategoryServer"
        }
      }))}`;
    }
    return `https://u.y.qq.com/cgi-bin/musicu.fcg?loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0&data=${encodeURIComponent(JSON.stringify({
      comm: { cv: 1602, ct: 20 },
      playlist: {
        method: "get_playlist_by_tag",
        param: { id: 1e7, sin: this.limit_list * (page - 1), size: this.limit_list, order: sortId, cur_page: page },
        module: "playlist.PlayListPlazaServer"
      }
    }))}`;
  },
  getListDetailUrl(id) {
    return `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${id}&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`;
  },
  // http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=2849349915&pn=0&rn=100&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1
  // 获取标签
  getTag(tryNum = 0) {
    if (this._requestObj_tags) this._requestObj_tags.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_tags = httpFetch(this.tagsUrl);
    return this._requestObj_tags.promise.then(({ body }) => {
      if (body.code !== this.successCode) return this.getTag(++tryNum);
      return this.filterTagInfo(body.tags.data.v_group);
    });
  },
  // 获取标签
  getHotTag(tryNum = 0) {
    if (this._requestObj_hotTags) this._requestObj_hotTags.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_hotTags = httpFetch(this.hotTagUrl);
    return this._requestObj_hotTags.promise.then(({ statusCode, body }) => {
      if (statusCode !== 200) return this.getHotTag(++tryNum);
      return this.filterInfoHotTag(body);
    });
  },
  filterInfoHotTag(html) {
    let hotTag = html.match(this.regExps.hotTagHtml);
    const hotTags = [];
    if (!hotTag) return hotTags;
    hotTag.forEach((tagHtml) => {
      let result = tagHtml.match(this.regExps.hotTag);
      if (!result) return;
      hotTags.push({
        id: parseInt(result[1]),
        name: result[2],
        source: "tx"
      });
    });
    return hotTags;
  },
  filterTagInfo(rawList) {
    return rawList.map((type) => ({
      name: type.group_name,
      list: type.v_item.map((item) => ({
        parent_id: type.group_id,
        parent_name: type.group_name,
        id: item.id,
        name: item.name,
        source: "tx"
      }))
    }));
  },
  // 获取列表数据
  getList(sortId, tagId, page, tryNum = 0) {
    if (this._requestObj_list) this._requestObj_list.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_list = httpFetch(
      this.getListUrl(sortId, tagId, page)
    );
    return this._requestObj_list.promise.then(({ body }) => {
      if (body.code !== this.successCode) return this.getList(sortId, tagId, page, ++tryNum);
      return tagId ? this.filterList2(body.playlist.data, page) : this.filterList(body.playlist.data, page);
    });
  },
  filterList(data, page) {
    return {
      list: data.v_playlist.map((item) => {
        var _a;
        return {
          play_count: formatPlayCount(item.access_num),
          id: String(item.tid),
          author: item.creator_info.nick,
          name: item.title,
          time: item.modify_time ? dateFormat(item.modify_time * 1e3, "Y-M-D") : "",
          img: item.cover_url_medium,
          // grade: item.favorcnt / 10,
          total: (_a = item.song_ids) == null ? void 0 : _a.length,
          desc: decodeName(item.desc).replace(/<br>/g, "\n"),
          source: "tx"
        };
      }),
      total: data.total,
      page,
      limit: this.limit_list,
      source: "tx"
    };
  },
  filterList2({ content }, page) {
    return {
      list: content.v_item.map(({ basic }) => ({
        play_count: formatPlayCount(basic.play_cnt),
        id: String(basic.tid),
        author: basic.creator.nick,
        name: basic.title,
        // time: basic.publish_time,
        img: basic.cover.medium_url || basic.cover.default_url,
        // grade: basic.favorcnt / 10,
        desc: decodeName(basic.desc).replace(/<br>/g, "\n"),
        source: "tx"
      })),
      total: content.total_cnt,
      page,
      limit: this.limit_list,
      source: "tx"
    };
  },
  async handleParseId(link, retryNum = 0) {
    if (retryNum > 2) return Promise.reject(new Error("link try max num"));
    const requestObj_listDetailLink = httpFetch(link);
    const { headers: { location }, statusCode } = await requestObj_listDetailLink.promise;
    if (statusCode > 400) return this.handleParseId(link, ++retryNum);
    return location == null ? link : location;
  },
  async getListId(id) {
    if (/[?&:/]/.test(id)) {
      if (!this.regExps.listDetailLink.test(id)) {
        id = await this.handleParseId(id);
      }
      let result = this.regExps.listDetailLink.exec(id);
      if (!result) {
        result = this.regExps.listDetailLink2.exec(id);
        if (!result) throw new Error("failed");
      }
      id = result[1];
    }
    return id;
  },
  // 获取歌曲列表内的音乐
  async getListDetail(id, tryNum = 0) {
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    id = await this.getListId(id);
    const requestObj_listDetail = httpFetch(this.getListDetailUrl(id), {
      headers: {
        Origin: "https://y.qq.com",
        Referer: `https://y.qq.com/n/yqq/playsquare/${id}.html`
      }
    });
    const { body } = await requestObj_listDetail.promise;
    if (body.code !== this.successCode) return this.getListDetail(id, ++tryNum);
    const cdlist = body.cdlist[0];
    return {
      list: this.filterListDetail(cdlist.songlist),
      page: 1,
      limit: cdlist.songlist.length + 1,
      total: cdlist.songlist.length,
      source: "tx",
      info: {
        name: cdlist.dissname,
        img: cdlist.logo,
        desc: decodeName(cdlist.desc).replace(/<br>/g, "\n"),
        author: cdlist.nickname,
        play_count: formatPlayCount(cdlist.visitnum)
      }
    };
  },
  filterListDetail(rawList) {
    return rawList.map((item) => {
      var _a;
      let types = [];
      let _types = {};
      if (item.file.size_128mp3 !== 0) {
        let size = sizeFormate(item.file.size_128mp3);
        types.push({ type: "128k", size });
        _types["128k"] = {
          size
        };
      }
      if (item.file.size_320mp3 !== 0) {
        let size = sizeFormate(item.file.size_320mp3);
        types.push({ type: "320k", size });
        _types["320k"] = {
          size
        };
      }
      if (item.file.size_flac !== 0) {
        let size = sizeFormate(item.file.size_flac);
        types.push({ type: "flac", size });
        _types.flac = {
          size
        };
      }
      if (item.file.size_hires !== 0) {
        let size = sizeFormate(item.file.size_hires);
        types.push({ type: "flac24bit", size });
        _types.flac24bit = {
          size
        };
      }
      return {
        singer: formatSingerName(item.singer, "name"),
        name: item.title,
        albumName: item.album.name,
        albumId: item.album.mid,
        source: "tx",
        interval: formatPlayTime(item.interval),
        songId: item.id,
        albumMid: item.album.mid,
        strMediaMid: item.file.media_mid,
        songmid: item.mid,
        img: item.album.name === "" || item.album.name === "\u7A7A" ? ((_a = item.singer) == null ? void 0 : _a.length) ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg` : "" : `https://y.gtimg.cn/music/photo_new/T002R500x500M000${item.album.mid}.jpg`,
        lrc: null,
        otherSource: null,
        types,
        _types,
        typeUrl: {}
      };
    });
  },
  getTags() {
    return Promise.all([this.getTag(), this.getHotTag()]).then(([tags, hotTag]) => ({ tags, hotTag, source: "tx" }));
  },
  async getDetailPageUrl(id) {
    id = await this.getListId(id);
    return `https://y.qq.com/n/ryqq/playlist/${id}`;
  },
  search(text, page, limit = 20, retryNum = 0) {
    if (retryNum > 5) throw new Error("max retry");
    return httpFetch(`http://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist?page_no=${page - 1}&num_per_page=${limit}&format=json&query=${encodeURIComponent(text)}&remoteplace=txt.yqq.playlist&inCharset=utf8&outCharset=utf-8`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)",
        Referer: "http://y.qq.com/portal/search.html"
      }
    }).promise.then(({ body }) => {
      if (body.code != 0) return this.search(text, page, limit, ++retryNum);
      return {
        list: body.data.list.map((item) => {
          return {
            play_count: formatPlayCount(item.listennum),
            id: String(item.dissid),
            author: decodeName(item.creator.name),
            name: decodeName(item.dissname),
            time: dateFormat(item.createtime, "Y-M-D"),
            img: item.imgurl,
            // grade: item.favorcnt / 10,
            total: item.song_count,
            desc: decodeName(decodeName(item.introduction)).replace(/<br>/g, "\n"),
            source: "tx"
          };
        }),
        limit,
        total: body.data.sum,
        source: "tx"
      };
    });
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/tx/utils/crypto.js
var import_node_crypto = __toESM(require("node:crypto"));
var PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19];
var PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5];
var SCRAMBLE_VALUES = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
async function hashSHA1(data) {
  return import_node_crypto.default.createHash("sha1").update(data).digest("hex");
}
function pickHashByIdx(hash, indexes) {
  return indexes.map((idx) => hash[idx]).join("");
}
function base64Encode(data) {
  return Buffer.from(data).toString("base64").replace(/[\\/+=]/g, "");
}
async function zzcSign(text) {
  const hash = await hashSHA1(text);
  const part1 = pickHashByIdx(hash, PART_1_INDEXES);
  const part2 = pickHashByIdx(hash, PART_2_INDEXES);
  const part3 = SCRAMBLE_VALUES.map((value, i) => value ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16));
  const b64Part = base64Encode(part3).replace(/[\\/+=]/g, "");
  return `zzc${part1}${b64Part}${part2}`.toLowerCase();
}

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/tx/utils/index.js
var signRequest = async (data) => {
  const sign = await zzcSign(JSON.stringify(data));
  return httpFetch(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, {
    method: "post",
    headers: {
      "User-Agent": "QQMusic 14090508(android 12)"
    },
    body: data
  }).promise;
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/tx/musicSearch.js
var musicSearch_default3 = {
  limit: 50,
  total: 0,
  page: 0,
  allPage: 1,
  successCode: 0,
  musicSearch(str, page, limit, retryNum = 0) {
    if (retryNum > 5) return Promise.reject(new Error("\u641C\u7D22\u5931\u8D25"));
    const searchRequest = signRequest({
      comm: {
        ct: "11",
        cv: "14090508",
        v: "14090508",
        tmeAppID: "qqmusic",
        phonetype: "EBG-AN10",
        deviceScore: "553.47",
        devicelevel: "50",
        newdevicelevel: "20",
        rom: "HuaWei/EMOTION/EmotionUI_14.2.0",
        os_ver: "12",
        OpenUDID: "0",
        OpenUDID2: "0",
        QIMEI36: "0",
        udid: "0",
        chid: "0",
        aid: "0",
        oaid: "0",
        taid: "0",
        tid: "0",
        wid: "0",
        uid: "0",
        sid: "0",
        modeSwitch: "6",
        teenMode: "0",
        ui_mode: "2",
        nettype: "1020",
        v4ip: ""
      },
      req: {
        module: "music.search.SearchCgiService",
        method: "DoSearchForQQMusicMobile",
        param: {
          search_type: 0,
          searchid: Math.random().toString().slice(2),
          query: str,
          page_num: page,
          num_per_page: limit,
          highlight: 0,
          nqc_flag: 0,
          multi_zhida: 0,
          cat: 2,
          grp: 1,
          sin: 0,
          sem: 0
        }
      }
    });
    return searchRequest.then(({ body }) => {
      if (!body || !body.req || body.code != this.successCode || body.req.code != this.successCode) {
        return this.musicSearch(str, page, limit, ++retryNum);
      }
      return body.req.data;
    });
  },
  // randomInt(min, max) {
  //   return Math.floor(Math.random() * (max - min + 1)) + min
  // },
  // getSearchId() {
  //   const e = BigInt(this.randomInt(1, 20))
  //   const t = e * 18014398509481984n
  //   const n = BigInt(this.randomInt(0, 4194304)) * 4294967296n
  //   const a = BigInt(Date.now())
  //   const r = (a * 1000n) % (24n * 60n * 60n * 1000n)
  //   return String(t + n + r)
  // },
  handleResult(rawList) {
    if (!rawList || !Array.isArray(rawList)) return [];
    const list = [];
    rawList.forEach((item) => {
      var _a, _b, _c;
      if (!((_a = item.file) == null ? void 0 : _a.media_mid)) return;
      let types = [];
      let _types = {};
      const file = item.file;
      if (file.size_128mp3 != 0) {
        let size = sizeFormate(file.size_128mp3);
        types.push({ type: "128k", size });
        _types["128k"] = {
          size
        };
      }
      if (file.size_320mp3 !== 0) {
        let size = sizeFormate(file.size_320mp3);
        types.push({ type: "320k", size });
        _types["320k"] = {
          size
        };
      }
      if (file.size_flac !== 0) {
        let size = sizeFormate(file.size_flac);
        types.push({ type: "flac", size });
        _types.flac = {
          size
        };
      }
      if (file.size_hires !== 0) {
        let size = sizeFormate(file.size_hires);
        types.push({ type: "flac24bit", size });
        _types.flac24bit = {
          size
        };
      }
      let albumId = "";
      let albumName = "";
      if (item.album) {
        albumName = item.album.name;
        albumId = item.album.mid;
      }
      list.push({
        singer: formatSingerName(item.singer, "name"),
        // name: item.name + (item.title_extra ?? ''),
        name: item.title,
        albumName,
        albumId,
        source: "tx",
        interval: formatPlayTime(item.interval),
        songId: item.id,
        albumMid: ((_b = item.album) == null ? void 0 : _b.mid) ?? "",
        strMediaMid: item.file.media_mid,
        songmid: item.mid,
        img: albumId === "" || albumId === "\u7A7A" ? ((_c = item.singer) == null ? void 0 : _c.length) ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${item.singer[0].mid}.jpg` : "" : `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg`,
        types,
        _types,
        typeUrl: {}
      });
    });
    return list;
  },
  search(str, page = 1, limit) {
    if (limit == null) limit = this.limit;
    return this.musicSearch(str, page, limit).then(({ body, meta }) => {
      let list = this.handleResult(body.item_song);
      this.total = meta.estimate_sum;
      this.page = page;
      this.allPage = Math.ceil(this.total / limit);
      return Promise.resolve({
        list,
        allPage: this.allPage,
        limit,
        total: this.total,
        source: "tx"
      });
    });
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/wy/utils/crypto.js
var import_crypto4 = require("crypto");
var iv = Buffer.from("0102030405060708");
var presetKey = Buffer.from("0CoJUm6Qyw8W8jud");
var linuxapiKey = Buffer.from("rFgB&h#%2?^eDg:Q");
var base62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
var publicKey = "-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----";
var eapiKey = "e82ckenh8dichen8";
var aesEncrypt = (buffer, mode, key, iv2) => {
  const cipher = (0, import_crypto4.createCipheriv)(mode, key, iv2);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
};
var rsaEncrypt = (buffer, key) => {
  buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer]);
  return (0, import_crypto4.publicEncrypt)({ key, padding: import_crypto4.constants.RSA_NO_PADDING }, buffer);
};
var weapi = (object) => {
  const text = JSON.stringify(object);
  const secretKey = (0, import_crypto4.randomBytes)(16).map((n) => base62.charAt(n % 62).charCodeAt());
  return {
    params: aesEncrypt(Buffer.from(aesEncrypt(Buffer.from(text), "aes-128-cbc", presetKey, iv).toString("base64")), "aes-128-cbc", secretKey, iv).toString("base64"),
    encSecKey: rsaEncrypt(secretKey.reverse(), publicKey).toString("hex")
  };
};
var linuxapi = (object) => {
  const text = JSON.stringify(object);
  return {
    eparams: aesEncrypt(Buffer.from(text), "aes-128-ecb", linuxapiKey, "").toString("hex").toUpperCase()
  };
};
var eapi = (url, object) => {
  const text = typeof object === "object" ? JSON.stringify(object) : object;
  const message = `nobody${url}use${text}md5forencrypt`;
  const digest = (0, import_crypto4.createHash)("md5").update(message).digest("hex");
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return {
    params: aesEncrypt(Buffer.from(data), "aes-128-ecb", eapiKey, "").toString("hex").toUpperCase()
  };
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/wy/musicDetail.js
var musicDetail_default = {
  getSinger(singers) {
    let arr = [];
    singers == null ? void 0 : singers.forEach((singer) => {
      arr.push(singer.name);
    });
    return arr.join("\u3001");
  },
  filterList({ songs, privileges }) {
    const list = [];
    songs.forEach((item, index) => {
      var _a, _b, _c, _d, _e;
      const types = [];
      const _types = {};
      let size;
      let privilege = privileges[index];
      if (privilege.id !== item.id) privilege = privileges.find((p) => p.id === item.id);
      if (!privilege) return;
      if (privilege.maxBrLevel == "hires") {
        size = item.hr ? sizeFormate(item.hr.size) : null;
        types.push({ type: "flac24bit", size });
        _types.flac24bit = {
          size
        };
      }
      switch (privilege.maxbr) {
        case 999e3:
          size = item.sq ? sizeFormate(item.sq.size) : null;
          types.push({ type: "flac", size });
          _types.flac = {
            size
          };
        case 32e4:
          size = item.h ? sizeFormate(item.h.size) : null;
          types.push({ type: "320k", size });
          _types["320k"] = {
            size
          };
        case 192e3:
        case 128e3:
          size = item.l ? sizeFormate(item.l.size) : null;
          types.push({ type: "128k", size });
          _types["128k"] = {
            size
          };
      }
      types.reverse();
      if (item.pc) {
        list.push({
          singer: item.pc.ar ?? "",
          name: item.pc.sn ?? "",
          albumName: item.pc.alb ?? "",
          albumId: (_a = item.al) == null ? void 0 : _a.id,
          source: "wy",
          interval: formatPlayTime(item.dt / 1e3),
          songmid: item.id,
          img: ((_b = item.al) == null ? void 0 : _b.picUrl) ?? "",
          lrc: null,
          otherSource: null,
          types,
          _types,
          typeUrl: {}
        });
      } else {
        list.push({
          singer: this.getSinger(item.ar),
          name: item.name ?? "",
          albumName: (_c = item.al) == null ? void 0 : _c.name,
          albumId: (_d = item.al) == null ? void 0 : _d.id,
          source: "wy",
          interval: formatPlayTime(item.dt / 1e3),
          songmid: item.id,
          img: (_e = item.al) == null ? void 0 : _e.picUrl,
          lrc: null,
          otherSource: null,
          types,
          _types,
          typeUrl: {}
        });
      }
    });
    return list;
  },
  async getList(ids = [], retryNum = 0) {
    if (retryNum > 2) return Promise.reject(new Error("try max num"));
    const requestObj = httpFetch("https://music.163.com/weapi/v3/song/detail", {
      method: "post",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
        origin: "https://music.163.com"
      },
      form: weapi({
        c: "[" + ids.map((id) => '{"id":' + id + "}").join(",") + "]",
        ids: "[" + ids.join(",") + "]"
      })
    });
    const { body, statusCode } = await requestObj.promise;
    if (statusCode != 200 || body.code !== 200) throw new Error("\u83B7\u53D6\u6B4C\u66F2\u8BE6\u60C5\u5931\u8D25");
    return { source: "wy", list: this.filterList(body) };
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/wy/leaderboard.js
var topList = [
  { id: "wy__19723756", name: "\u98D9\u5347\u699C", bangid: "19723756" },
  { id: "wy__3779629", name: "\u65B0\u6B4C\u699C", bangid: "3779629" },
  { id: "wy__2884035", name: "\u539F\u521B\u699C", bangid: "2884035" },
  { id: "wy__3778678", name: "\u70ED\u6B4C\u699C", bangid: "3778678" },
  { id: "wy__991319590", name: "\u8BF4\u5531\u699C", bangid: "991319590" },
  { id: "wy__71384707", name: "\u53E4\u5178\u699C", bangid: "71384707" },
  { id: "wy__1978921795", name: "\u7535\u97F3\u699C", bangid: "1978921795" },
  { id: "wy__5453912201", name: "\u9ED1\u80F6VIP\u7231\u542C\u699C", bangid: "5453912201" },
  { id: "wy__71385702", name: "ACG\u699C", bangid: "71385702" },
  { id: "wy__745956260", name: "\u97E9\u8BED\u699C", bangid: "745956260" },
  { id: "wy__10520166", name: "\u56FD\u7535\u699C", bangid: "10520166" },
  { id: "wy__180106", name: "UK\u6392\u884C\u699C\u5468\u699C", bangid: "180106" },
  { id: "wy__60198", name: "\u7F8E\u56FDBillboard\u699C", bangid: "60198" },
  { id: "wy__3812895", name: "Beatport\u5168\u7403\u7535\u5B50\u821E\u66F2\u699C", bangid: "3812895" },
  { id: "wy__21845217", name: "KTV\u551B\u699C", bangid: "21845217" },
  { id: "wy__60131", name: "\u65E5\u672COricon\u699C", bangid: "60131" },
  { id: "wy__2809513713", name: "\u6B27\u7F8E\u70ED\u6B4C\u699C", bangid: "2809513713" },
  { id: "wy__2809577409", name: "\u6B27\u7F8E\u65B0\u6B4C\u699C", bangid: "2809577409" },
  { id: "wy__27135204", name: "\u6CD5\u56FD NRJ Vos Hits \u5468\u699C", bangid: "27135204" },
  { id: "wy__3001835560", name: "ACG\u52A8\u753B\u699C", bangid: "3001835560" },
  { id: "wy__3001795926", name: "ACG\u6E38\u620F\u699C", bangid: "3001795926" },
  { id: "wy__3001890046", name: "ACG VOCALOID\u699C", bangid: "3001890046" },
  { id: "wy__3112516681", name: "\u4E2D\u56FD\u65B0\u4E61\u6751\u97F3\u4E50\u6392\u884C\u699C", bangid: "3112516681" },
  { id: "wy__5059644681", name: "\u65E5\u8BED\u699C", bangid: "5059644681" },
  { id: "wy__5059633707", name: "\u6447\u6EDA\u699C", bangid: "5059633707" },
  { id: "wy__5059642708", name: "\u56FD\u98CE\u699C", bangid: "5059642708" },
  { id: "wy__5338990334", name: "\u6F5C\u529B\u7206\u6B3E\u699C", bangid: "5338990334" },
  { id: "wy__5059661515", name: "\u6C11\u8C23\u699C", bangid: "5059661515" },
  { id: "wy__6688069460", name: "\u542C\u6B4C\u8BC6\u66F2\u699C", bangid: "6688069460" },
  { id: "wy__6723173524", name: "\u7F51\u7EDC\u70ED\u6B4C\u699C", bangid: "6723173524" },
  { id: "wy__6732051320", name: "\u4FC4\u8BED\u699C", bangid: "6732051320" },
  { id: "wy__6732014811", name: "\u8D8A\u5357\u8BED\u699C", bangid: "6732014811" },
  { id: "wy__6886768100", name: "\u4E2D\u6587DJ\u699C", bangid: "6886768100" },
  { id: "wy__6939992364", name: "\u4FC4\u7F57\u65AFtop hit\u6D41\u884C\u97F3\u4E50\u699C", bangid: "6939992364" },
  { id: "wy__7095271308", name: "\u6CF0\u8BED\u699C", bangid: "7095271308" },
  { id: "wy__7356827205", name: "BEAT\u6392\u884C\u699C", bangid: "7356827205" },
  { id: "wy__7325478166", name: "\u7F16\u8F91\u63A8\u8350\u699CVOL.44 \u5929\u624D\u5973\u5B50\u6447\u6EDA\u4E50\u961Fboygenius\u5256\u767D\u5351\u5FAE\u5FC3\u8FF9", bangid: "7325478166" },
  { id: "wy__7603212484", name: "LOOK\u76F4\u64AD\u6B4C\u66F2\u699C", bangid: "7603212484" },
  { id: "wy__7775163417", name: "\u8D4F\u97F3\u699C", bangid: "7775163417" },
  { id: "wy__7785123708", name: "\u9ED1\u80F6VIP\u65B0\u6B4C\u699C", bangid: "7785123708" },
  { id: "wy__7785066739", name: "\u9ED1\u80F6VIP\u70ED\u6B4C\u699C", bangid: "7785066739" },
  { id: "wy__7785091694", name: "\u9ED1\u80F6VIP\u7231\u641C\u699C", bangid: "7785091694" }
];
var leaderboard_default4 = {
  limit: 1e5,
  list: [
    {
      id: "wybsb",
      name: "\u98D9\u5347\u699C",
      bangid: "19723756"
    },
    {
      id: "wyrgb",
      name: "\u70ED\u6B4C\u699C",
      bangid: "3778678"
    },
    {
      id: "wyxgb",
      name: "\u65B0\u6B4C\u699C",
      bangid: "3779629"
    },
    {
      id: "wyycb",
      name: "\u539F\u521B\u699C",
      bangid: "2884035"
    },
    {
      id: "wygdb",
      name: "\u53E4\u5178\u699C",
      bangid: "71384707"
    },
    {
      id: "wydouyb",
      name: "\u6296\u97F3\u699C",
      bangid: "2250011882"
    },
    {
      id: "wyhyb",
      name: "\u97E9\u8BED\u699C",
      bangid: "745956260"
    },
    {
      id: "wydianyb",
      name: "\u7535\u97F3\u699C",
      bangid: "1978921795"
    },
    {
      id: "wydjb",
      name: "\u7535\u7ADE\u699C",
      bangid: "2006508653"
    },
    {
      id: "wyktvbb",
      name: "KTV\u551B\u699C",
      bangid: "21845217"
    }
  ],
  getUrl(id) {
    return `https://music.163.com/discover/toplist?id=${id}`;
  },
  regExps: {
    list: /<textarea id="song-list-pre-data" style="display:none;">(.+?)<\/textarea>/
  },
  _requestBoardsObj: null,
  getBoardsData() {
    if (this._requestBoardsObj) this._requestBoardsObj.cancelHttp();
    this._requestBoardsObj = httpFetch("https://music.163.com/weapi/toplist", {
      method: "post",
      form: weapi({})
    });
    return this._requestBoardsObj.promise;
  },
  getData(id) {
    const requestBoardsDetailObj = httpFetch("https://music.163.com/weapi/v3/playlist/detail", {
      method: "post",
      form: weapi({
        id,
        n: 1e5,
        p: 1
      })
    });
    return requestBoardsDetailObj.promise;
  },
  filterBoardsData(rawList) {
    let list = [];
    for (const board of rawList) {
      list.push({
        id: "wy__" + board.id,
        name: board.name,
        bangid: String(board.id)
      });
    }
    return list;
  },
  async getBoards(retryNum = 0) {
    this.list = topList;
    return {
      list: topList,
      source: "wy"
    };
  },
  async getList(bangid, page, retryNum = 0) {
    if (++retryNum > 6) return Promise.reject(new Error("try max num"));
    let resp;
    try {
      resp = await this.getData(bangid);
    } catch (err) {
      if (err.message == "try max num") {
        throw err;
      } else {
        return this.getList(bangid, page, retryNum);
      }
    }
    if (resp.statusCode !== 200 || resp.body.code !== 200) return this.getList(bangid, page, retryNum);
    let musicDetail;
    try {
      musicDetail = await musicDetail_default.getList(resp.body.playlist.trackIds.map((trackId) => trackId.id));
    } catch (err) {
      console.log(err);
      if (err.message == "try max num") {
        throw err;
      } else {
        return this.getList(bangid, page, retryNum);
      }
    }
    return {
      total: musicDetail.list.length,
      list: musicDetail.list,
      limit: this.limit,
      page,
      source: "wy"
    };
  },
  getDetailPageUrl(id) {
    if (typeof id == "string") id = id.replace("wy__", "");
    return `https://music.163.com/#/discover/toplist?id=${id}`;
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/wy/utils/index.js
var eapiRequest = (url, data) => {
  return httpFetch("http://interface.music.163.com/eapi/batch", {
    method: "post",
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
      origin: "https://music.163.com"
      // cookie: 'os=pc; deviceId=A9C064BB4584D038B1565B58CB05F95290998EE8B025AA2D07AE; osver=Microsoft-Windows-10-Home-China-build-19043-64bit; appver=2.5.2.197409; channel=netease; MUSIC_A=37a11f2eb9de9930cad479b2ad495b0e4c982367fb6f909d9a3f18f876c6b49faddb3081250c4980dd7e19d4bd9bf384e004602712cf2b2b8efaafaab164268a00b47359f85f22705cc95cb6180f3aee40f5be1ebf3148d888aa2d90636647d0c3061cd18d77b7a0; __csrf=05b50d54082694f945d7de75c210ef94; mode=Z7M-KP5(7)GZ; NMTID=00OZLp2VVgq9QdwokUgq3XNfOddQyIAAAF_6i8eJg; ntes_kaola_ad=1',
    },
    form: eapi(url, data)
  });
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/wy/songList.js
var songList_default4 = {
  _requestObj_tags: null,
  _requestObj_hotTags: null,
  _requestObj_list: null,
  limit_list: 30,
  limit_song: 1e5,
  successCode: 200,
  cookie: "MUSIC_U=",
  sortList: [
    {
      name: "\u6700\u70ED",
      id: "hot"
    }
    // {
    //   name: '最新',
    //   id: 'new',
    // },
  ],
  regExps: {
    listDetailLink: /^.+(?:\?|&)id=(\d+)(?:&.*$|#.*$|$)/,
    listDetailLink2: /^.+\/playlist\/(\d+)\/\d+\/.+$/
  },
  async handleParseId(link, retryNum = 0) {
    if (retryNum > 2) throw new Error("link try max num");
    const requestObj_listDetailLink = httpFetch(link);
    const { headers: { location }, statusCode } = await requestObj_listDetailLink.promise;
    if (statusCode > 400) return this.handleParseId(link, ++retryNum);
    const url = location == null ? link : location;
    return this.regExps.listDetailLink.test(url) ? url.replace(this.regExps.listDetailLink, "$1") : url.replace(this.regExps.listDetailLink2, "$1");
  },
  async getListId(id) {
    let cookie;
    if (/###/.test(id)) {
      const [url, token] = id.split("###");
      id = url;
      cookie = `MUSIC_U=${token}`;
    }
    if (/[?&:/]/.test(id)) {
      if (this.regExps.listDetailLink.test(id)) {
        id = id.replace(this.regExps.listDetailLink, "$1");
      } else if (this.regExps.listDetailLink2.test(id)) {
        id = id.replace(this.regExps.listDetailLink2, "$1");
      } else {
        id = await this.handleParseId(id);
      }
    }
    return { id, cookie };
  },
  async getListDetail(rawId, page, tryNum = 0) {
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    const { id, cookie } = await this.getListId(rawId);
    if (cookie) this.cookie = cookie;
    const requestObj_listDetail = httpFetch("https://music.163.com/api/linux/forward", {
      method: "post",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
        Cookie: this.cookie
      },
      form: linuxapi({
        method: "POST",
        url: "https://music.163.com/api/v3/playlist/detail",
        params: {
          id,
          n: this.limit_song,
          s: 8
        }
      })
    });
    const { statusCode, body } = await requestObj_listDetail.promise;
    if (statusCode !== 200 || body.code !== this.successCode) return this.getListDetail(id, page, ++tryNum);
    let limit = 1e3;
    let rangeStart = (page - 1) * limit;
    let list;
    if (body.playlist.trackIds.length == body.privileges.length) {
      list = this.filterListDetail(body);
    } else {
      try {
        list = (await musicDetail_default.getList(body.playlist.trackIds.slice(rangeStart, limit * page).map((trackId) => trackId.id))).list;
      } catch (err) {
        console.log(err);
        if (err.message == "try max num") {
          throw err;
        } else {
          return this.getListDetail(id, page, ++tryNum);
        }
      }
    }
    return {
      list,
      page,
      limit,
      total: body.playlist.trackIds.length,
      source: "wy",
      info: {
        play_count: formatPlayCount(body.playlist.playCount),
        name: body.playlist.name,
        img: body.playlist.coverImgUrl,
        desc: body.playlist.description,
        author: body.playlist.creator.nickname
      }
    };
  },
  filterListDetail({ playlist: { tracks }, privileges }) {
    const list = [];
    tracks.forEach((item, index) => {
      var _a, _b, _c, _d, _e;
      const types = [];
      const _types = {};
      let size;
      let privilege = privileges[index];
      if (privilege.id !== item.id) privilege = privileges.find((p) => p.id === item.id);
      if (!privilege) return;
      if (privilege.maxBrLevel == "hires") {
        size = item.hr ? sizeFormate(item.hr.size) : null;
        types.push({ type: "flac24bit", size });
        _types.flac24bit = {
          size
        };
      }
      switch (privilege.maxbr) {
        case 999e3:
          size = null;
          types.push({ type: "flac", size });
          _types.flac = {
            size
          };
        case 32e4:
          size = item.h ? sizeFormate(item.h.size) : null;
          types.push({ type: "320k", size });
          _types["320k"] = {
            size
          };
        case 192e3:
        case 128e3:
          size = item.l ? sizeFormate(item.l.size) : null;
          types.push({ type: "128k", size });
          _types["128k"] = {
            size
          };
      }
      types.reverse();
      if (item.pc) {
        list.push({
          singer: item.pc.ar ?? "",
          name: item.pc.sn ?? "",
          albumName: item.pc.alb ?? "",
          albumId: (_a = item.al) == null ? void 0 : _a.id,
          source: "wy",
          interval: formatPlayTime(item.dt / 1e3),
          songmid: item.id,
          img: ((_b = item.al) == null ? void 0 : _b.picUrl) ?? "",
          lrc: null,
          otherSource: null,
          types,
          _types,
          typeUrl: {}
        });
      } else {
        list.push({
          singer: formatSingerName(item.ar, "name"),
          name: item.name ?? "",
          albumName: (_c = item.al) == null ? void 0 : _c.name,
          albumId: (_d = item.al) == null ? void 0 : _d.id,
          source: "wy",
          interval: formatPlayTime(item.dt / 1e3),
          songmid: item.id,
          img: (_e = item.al) == null ? void 0 : _e.picUrl,
          lrc: null,
          otherSource: null,
          types,
          _types,
          typeUrl: {}
        });
      }
    });
    return list;
  },
  // 获取列表数据
  getList(sortId, tagId, page, tryNum = 0) {
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    if (this._requestObj_list) this._requestObj_list.cancelHttp();
    this._requestObj_list = httpFetch("https://music.163.com/weapi/playlist/list", {
      method: "post",
      form: weapi({
        cat: tagId || "\u5168\u90E8",
        // 全部,华语,欧美,日语,韩语,粤语,小语种,流行,摇滚,民谣,电子,舞曲,说唱,轻音乐,爵士,乡村,R&B/Soul,古典,民族,英伦,金属,朋克,蓝调,雷鬼,世界音乐,拉丁,另类/独立,New Age,古风,后摇,Bossa Nova,清晨,夜晚,学习,工作,午休,下午茶,地铁,驾车,运动,旅行,散步,酒吧,怀旧,清新,浪漫,性感,伤感,治愈,放松,孤独,感动,兴奋,快乐,安静,思念,影视原声,ACG,儿童,校园,游戏,70后,80后,90后,网络歌曲,KTV,经典,翻唱,吉他,钢琴,器乐,榜单,00后
        order: sortId,
        // hot,new
        limit: this.limit_list,
        offset: this.limit_list * (page - 1),
        total: true
      })
    });
    return this._requestObj_list.promise.then(({ body }) => {
      if (body.code !== this.successCode) return this.getList(sortId, tagId, page, ++tryNum);
      return {
        list: this.filterList(body.playlists),
        total: parseInt(body.total),
        page,
        limit: this.limit_list,
        source: "wy"
      };
    });
  },
  filterList(rawData) {
    return rawData.map((item) => ({
      play_count: formatPlayCount(item.playCount),
      id: String(item.id),
      author: item.creator.nickname,
      name: item.name,
      time: item.createTime ? dateFormat(item.createTime, "Y-M-D") : "",
      img: item.coverImgUrl,
      grade: item.grade,
      total: item.trackCount,
      desc: item.description,
      source: "wy"
    }));
  },
  // 获取标签
  getTag(tryNum = 0) {
    if (this._requestObj_tags) this._requestObj_tags.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_tags = httpFetch("https://music.163.com/weapi/playlist/catalogue", {
      method: "post",
      form: weapi({})
    });
    return this._requestObj_tags.promise.then(({ body }) => {
      if (body.code !== this.successCode) return this.getTag(++tryNum);
      return this.filterTagInfo(body);
    });
  },
  filterTagInfo({ sub, categories }) {
    const subList = {};
    for (const item of sub) {
      if (!subList[item.category]) subList[item.category] = [];
      subList[item.category].push({
        parent_id: categories[item.category],
        parent_name: categories[item.category],
        id: item.name,
        name: item.name,
        source: "wy"
      });
    }
    const list = [];
    for (const key of Object.keys(categories)) {
      list.push({
        name: categories[key],
        list: subList[key],
        source: "wy"
      });
    }
    return list;
  },
  // 获取热门标签
  getHotTag(tryNum = 0) {
    if (this._requestObj_hotTags) this._requestObj_hotTags.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_hotTags = httpFetch("https://music.163.com/weapi/playlist/hottags", {
      method: "post",
      form: weapi({})
    });
    return this._requestObj_hotTags.promise.then(({ body }) => {
      if (body.code !== this.successCode) return this.getTag(++tryNum);
      return this.filterHotTagInfo(body.tags);
    });
  },
  filterHotTagInfo(rawList) {
    return rawList.map((item) => ({
      id: item.playlistTag.name,
      name: item.playlistTag.name,
      source: "wy"
    }));
  },
  getTags() {
    return Promise.all([this.getTag(), this.getHotTag()]).then(([tags, hotTag]) => ({ tags, hotTag, source: "wy" }));
  },
  async getDetailPageUrl(rawId) {
    const { id } = await this.getListId(rawId);
    return `https://music.163.com/#/playlist?id=${id}`;
  },
  search(text, page, limit = 20) {
    return eapiRequest("/api/cloudsearch/pc", {
      s: text,
      type: 1e3,
      // 1: 单曲, 10: 专辑, 100: 歌手, 1000: 歌单, 1002: 用户, 1004: MV, 1006: 歌词, 1009: 电台, 1014: 视频
      limit,
      total: page == 1,
      offset: limit * (page - 1)
    }).promise.then(({ body }) => {
      if (body.code != this.successCode) throw new Error("filed");
      return {
        list: this.filterList(body.result.playlists),
        limit,
        total: body.result.playlistCount,
        source: "wy"
      };
    });
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/wy/musicSearch.js
var musicSearch_default4 = {
  limit: 30,
  total: 0,
  page: 0,
  allPage: 1,
  musicSearch(str, page, limit) {
    const searchRequest = eapiRequest("/api/search/song/list/page", {
      keyword: str,
      needCorrect: "1",
      channel: "typing",
      offset: limit * (page - 1),
      scene: "normal",
      total: page == 1,
      limit
    });
    return searchRequest.promise.then(({ body }) => body);
  },
  getSinger(singers) {
    let arr = [];
    singers.forEach((singer) => {
      arr.push(singer.name);
    });
    return arr.join("\u3001");
  },
  handleResult(rawList) {
    if (!rawList) return [];
    return rawList.map((item) => {
      item = item.baseInfo.simpleSongData;
      const types = [];
      const _types = {};
      let size;
      if (item.privilege.maxBrLevel == "hires") {
        size = item.hr ? sizeFormate(item.hr.size) : null;
        types.push({ type: "flac24bit", size });
        _types.flac24bit = {
          size
        };
      }
      switch (item.privilege.maxbr) {
        case 999e3:
          size = item.sq ? sizeFormate(item.sq.size) : null;
          types.push({ type: "flac", size });
          _types.flac = {
            size
          };
        case 32e4:
          size = item.h ? sizeFormate(item.h.size) : null;
          types.push({ type: "320k", size });
          _types["320k"] = {
            size
          };
        case 192e3:
        case 128e3:
          size = item.l ? sizeFormate(item.l.size) : null;
          types.push({ type: "128k", size });
          _types["128k"] = {
            size
          };
      }
      types.reverse();
      return {
        singer: this.getSinger(item.ar),
        name: item.name,
        albumName: item.al.name,
        albumId: item.al.id,
        source: "wy",
        interval: formatPlayTime(item.dt / 1e3),
        songmid: item.id,
        img: item.al.picUrl,
        lrc: null,
        types,
        _types,
        typeUrl: {}
      };
    });
  },
  search(str, page = 1, limit, retryNum = 0) {
    if (++retryNum > 3) return Promise.reject(new Error("try max num"));
    if (limit == null) limit = this.limit;
    return this.musicSearch(str, page, limit).then((result) => {
      if (!result || result.code !== 200) return this.search(str, page, limit, retryNum);
      let list = this.handleResult(result.data.resources || []);
      if (list == null) return this.search(str, page, limit, retryNum);
      this.total = result.data.totalCount || 0;
      this.page = page;
      this.allPage = Math.ceil(this.total / this.limit);
      return {
        list,
        allPage: this.allPage,
        limit: this.limit,
        total: this.total,
        source: "wy"
      };
    });
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/mg/utils/index.js
var createHttpFetch = async (url, options, retryNum = 0) => {
  if (retryNum > 2) throw new Error("try max num");
  let result;
  try {
    result = await httpFetch(url, options).promise;
  } catch (err) {
    console.log(err);
    return createHttpFetch(url, options, ++retryNum);
  }
  if (result.statusCode !== 200 || (result.body.code !== void 0 ? result.body.code : result.body.returnCode !== void 0 ? result.body.returnCode : result.body.code) !== "000000") return createHttpFetch(url, options, ++retryNum);
  if (result.body.data) return result.body.data;
  return result.body;
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/mg/musicInfo.js
var filterMusicInfoList = (rawList) => {
  let ids = /* @__PURE__ */ new Set();
  const list = [];
  rawList.forEach((item) => {
    var _a, _b;
    if (!item.songId || ids.has(item.songId)) return;
    ids.add(item.songId);
    const types = [];
    const _types = {};
    (_a = item.newRateFormats) == null ? void 0 : _a.forEach((type) => {
      let size;
      switch (type.formatType) {
        case "PQ":
          size = sizeFormate(type.size ?? type.androidSize);
          types.push({ type: "128k", size });
          _types["128k"] = {
            size
          };
          break;
        case "HQ":
          size = sizeFormate(type.size ?? type.androidSize);
          types.push({ type: "320k", size });
          _types["320k"] = {
            size
          };
          break;
        case "SQ":
          size = sizeFormate(type.size ?? type.androidSize);
          types.push({ type: "flac", size });
          _types.flac = {
            size
          };
          break;
        case "ZQ":
          size = sizeFormate(type.size ?? type.androidSize);
          types.push({ type: "flac24bit", size });
          _types.flac24bit = {
            size
          };
          break;
      }
    });
    const intervalTest = /(\d\d:\d\d)$/.test(item.length);
    list.push({
      singer: formatSingerName(item.artists, "name"),
      name: item.songName,
      albumName: item.album,
      albumId: item.albumId,
      songmid: item.songId,
      copyrightId: item.copyrightId,
      source: "mg",
      interval: intervalTest ? RegExp.$1 : null,
      img: ((_b = item.albumImgs) == null ? void 0 : _b.length) ? item.albumImgs[0].img : null,
      lrc: null,
      lrcUrl: item.lrcUrl,
      mrcUrl: item.mrcUrl,
      trcUrl: item.trcUrl,
      otherSource: null,
      types,
      _types,
      typeUrl: {}
    });
  });
  return list;
};
var filterMusicInfoListV5 = (rawList) => {
  let ids = /* @__PURE__ */ new Set();
  const list = [];
  rawList.forEach((item) => {
    var _a;
    if (!item.songId || ids.has(item.songId)) return;
    ids.add(item.songId);
    const types = [];
    const _types = {};
    (_a = item.audioFormats) == null ? void 0 : _a.forEach((type) => {
      let size;
      switch (type.formatType) {
        case "PQ":
          size = sizeFormate(type.size ?? type.androidSize);
          types.push({ type: "128k", size });
          _types["128k"] = {
            size
          };
          break;
        case "HQ":
          size = sizeFormate(type.size ?? type.androidSize);
          types.push({ type: "320k", size });
          _types["320k"] = {
            size
          };
          break;
        case "SQ":
          size = sizeFormate(type.size ?? type.androidSize);
          types.push({ type: "flac", size });
          _types.flac = {
            size
          };
          break;
        case "ZQ":
          size = sizeFormate(type.size ?? type.androidSize);
          types.push({ type: "flac24bit", size });
          _types.flac24bit = {
            size
          };
          break;
      }
    });
    list.push({
      singer: formatSingerName(item.singerList, "name"),
      name: item.songName,
      albumName: item.album,
      albumId: item.albumId,
      songmid: item.songId,
      copyrightId: item.copyrightId,
      source: "mg",
      interval: formatPlayTime(item.duration),
      img: (() => { const p = item.img3 || item.img2 || item.img1; return p ? (/^https?:/.test(p) ? p : "https://d.musicapp.migu.cn" + p) : null; })(),
      lrc: null,
      lrcUrl: item.lrcUrl,
      mrcUrl: item.mrcUrl,
      trcUrl: item.trcUrl,
      otherSource: null,
      types,
      _types,
      typeUrl: {}
    });
  });
  return list;
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/mg/leaderboard.js
var boardList4 = [
  {
    id: "mg__27553319",
    name: "\u65B0\u6B4C\u699C",
    bangid: "27553319",
    source: "mg"
  },
  {
    id: "mg__27186466",
    name: "\u70ED\u6B4C\u699C",
    bangid: "27186466",
    source: "mg"
  },
  {
    id: "mg__27553408",
    name: "\u539F\u521B\u699C",
    bangid: "27553408",
    source: "mg"
  },
  {
    id: "mg__75959118",
    name: "\u97F3\u4E50\u98CE\u5411\u699C",
    bangid: "75959118",
    source: "mg"
  },
  {
    id: "mg__76557036",
    name: "\u5F69\u94C3\u5206\u8D1D\u699C",
    bangid: "76557036",
    source: "mg"
  },
  {
    id: "mg__76557745",
    name: "\u4F1A\u5458\u81FB\u7231\u699C",
    bangid: "76557745",
    source: "mg"
  },
  {
    id: "mg__23189800",
    name: "\u6E2F\u53F0\u699C",
    bangid: "23189800",
    source: "mg"
  },
  {
    id: "mg__23189399",
    name: "\u5185\u5730\u699C",
    bangid: "23189399",
    source: "mg"
  },
  {
    id: "mg__19190036",
    name: "\u6B27\u7F8E\u699C",
    bangid: "19190036",
    source: "mg"
  },
  {
    id: "mg__83176390",
    name: "\u56FD\u98CE\u91D1\u66F2\u699C",
    bangid: "83176390",
    source: "mg"
  }
];
var leaderboard_default5 = {
  limit: 200,
  list: [
    {
      id: "mgyyb",
      name: "\u97F3\u4E50\u699C",
      bangid: "27553319"
    },
    {
      id: "mgysb",
      name: "\u5F71\u89C6\u699C",
      bangid: "23603721"
    },
    {
      id: "mghybnd",
      name: "\u534E\u8BED\u5185\u5730\u699C",
      bangid: "23603926"
    },
    {
      id: "mghyjqbgt",
      name: "\u534E\u8BED\u6E2F\u53F0\u699C",
      bangid: "23603954"
    },
    {
      id: "mgomb",
      name: "\u6B27\u7F8E\u699C",
      bangid: "23603974"
    },
    {
      id: "mgrhb",
      name: "\u65E5\u97E9\u699C",
      bangid: "23603982"
    },
    {
      id: "mgwlb",
      name: "\u7F51\u7EDC\u699C",
      bangid: "23604058"
    },
    {
      id: "mgclb",
      name: "\u5F69\u94C3\u699C",
      bangid: "23604023"
    },
    {
      id: "mgktvb",
      name: "KTV\u699C",
      bangid: "23604040"
    },
    {
      id: "mgrcb",
      name: "\u539F\u521B\u699C",
      bangid: "23604032"
    }
  ],
  getUrl(id, page) {
    return `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/querycontentbyId.do?columnId=${id}&needAll=0`;
  },
  successCode: "000000",
  requestBoardsObj: null,
  getBoardsData() {
    if (this.requestBoardsObj) this.requestBoardsObj.cancelHttp();
    this.requestBoardsObj = httpFetch("https://app.c.nf.migu.cn/pc/bmw/rank/rank-index/v1.0", {
      // this.requestBoardsObj = httpFetch('https://app.c.nf.migu.cn/MIGUM3.0/v1.0/template/rank-list/release', {
      // this.requestBoardsObj = httpFetch('https://app.c.nf.migu.cn/MIGUM2.0/v2.0/content/indexrank.do?templateVersion=8', {
      headers: {
        Referer: "https://app.c.nf.migu.cn/",
        "User-Agent": "Mozilla/5.0 (Linux; Android 5.1.1; Nexus 6 Build/LYZ28E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/59.0.3071.115 Mobile Safari/537.36",
        channel: "0146921"
      }
    });
    return this.requestBoardsObj.promise;
  },
  getData(url) {
    const requestObj = httpFetch(url);
    return requestObj.promise;
  },
  // filterBoardsData(listData, list = [], ids = new Set()) {
  //   for (const item of listData) {
  //     if (item.rankId && !ids.has(item.rankId)) {
  //       ids.add(item.rankId)
  //       list.push({
  //         id: 'mg__' + item.rankId,
  //         name: item.rankName,
  //         bangid: String(item.rankId),
  //         source: 'mg',
  //       })
  //     } else if (item.contents) this.filterBoardsData(item.contents, list, ids)
  //   }
  //   return list
  // },
  // filterBoardsData(rawList) {
  //   // console.log(rawList)
  //   let list = []
  //   for (const board of rawList) {
  //     if (board.template != 'group1') continue
  //     for (const item of board.itemList) {
  //       if ((item.template != 'row1' && item.template != 'grid1' && !item.actionUrl) || !item.actionUrl.includes('rank-info')) continue
  //       let data = item.displayLogId.param
  //       list.push({
  //         id: 'mg__' + data.rankId,
  //         name: data.rankName,
  //         bangid: String(data.rankId),
  //       })
  //     }
  //   }
  //   return list
  // },
  async getBoards(retryNum = 0) {
    this.list = boardList4;
    return {
      list: boardList4,
      source: "mg"
    };
  },
  getList(bangid, page, retryNum = 0) {
    if (++retryNum > 3) return Promise.reject(new Error("try max num"));
    return this.getData(this.getUrl(bangid, page)).then(({ statusCode, body }) => {
      if (statusCode !== 200 || body.code !== this.successCode) return this.getList(bangid, page, retryNum);
      const list = filterMusicInfoList(body.columnInfo.contents.map((m) => m.objectInfo));
      return {
        total: list.length,
        list,
        limit: this.limit,
        page,
        source: "mg"
      };
    });
  },
  getDetailPageUrl(id) {
    if (typeof id == "string") id = id.replace("mg__", "");
    for (const item of boardList4) {
      if (item.bangid == id) {
        return `https://music.migu.cn/v3/music/top/${item.webId}`;
      }
    }
    return null;
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/mg/musicSearch.js
var createSignature = (time, str) => {
  const deviceId = "963B7AA0D21511ED807EE5846EC87D20";
  const signatureMd5 = "6cdc72a439cef99a3418d2a78aa28c73";
  const sign = toMD5(`${str}${signatureMd5}yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`);
  return { sign, deviceId };
};
var musicSearch_default5 = {
  limit: 20,
  total: 0,
  page: 0,
  allPage: 1,
  // 旧版API
  // musicSearch(str, page, limit) {
  //   const searchRequest = httpFetch(`http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?ua=Android_migu&version=5.0.1&text=${encodeURIComponent(str)}&pageNo=${page}&pageSize=${limit}&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A0%2C%22mvSong%22%3A0%2C%22songlist%22%3A0%2C%22bestShow%22%3A1%7D`, {
  // searchRequest = httpFetch(`http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?ua=Android_migu&version=5.0.1&text=${encodeURIComponent(str)}&pageNo=${page}&pageSize=${limit}&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A0%2C%22mvSong%22%3A0%2C%22songlist%22%3A0%2C%22bestShow%22%3A1%7D`, {
  // searchRequest = httpFetch(`http://jadeite.migu.cn:7090/music_search/v2/search/searchAll?sid=4f87090d01c84984a11976b828e2b02c18946be88a6b4c47bcdc92fbd40762db&isCorrect=1&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(str)}&pageNo=${page}&sort=0`, {
  // searchRequest = httpFetch(`https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do?isCopyright=1&isCorrect=1&pageNo=${page}&pageSize=${limit}&searchSwitch={%22song%22:1,%22album%22:0,%22singer%22:0,%22tagSong%22:0,%22mvSong%22:0,%22songlist%22:0,%22bestShow%22:0}&sort=0&text=${encodeURIComponent(str)}`)
  //   // searchRequest = httpFetch(`http://jadeite.migu.cn:7090/music_search/v2/search/searchAll?sid=4f87090d01c84984a11976b828e2b02c18946be88a6b4c47bcdc92fbd40762db&isCorrect=1&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(str)}&pageNo=${page}&sort=0`, {
  //     headers: {
  //       // sign: 'c3b7ae985e2206e97f1b2de8f88691e2',
  //       // timestamp: 1578225871982,
  //       // appId: 'yyapp2',
  //       // mode: 'android',
  //       // ua: 'Android_migu',
  //       // version: '6.9.4',
  //       osVersion: 'android 7.0',
  //       'User-Agent': 'okhttp/3.9.1',
  //     },
  //   })
  //   // searchRequest = httpFetch(`https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do?isCopyright=1&isCorrect=1&pageNo=${page}&pageSize=${limit}&searchSwitch={%22song%22:1,%22album%22:0,%22singer%22:0,%22tagSong%22:0,%22mvSong%22:0,%22songlist%22:0,%22bestShow%22:0}&sort=0&text=${encodeURIComponent(str)}`)
  //   return searchRequest.promise.then(({ body }) => body)
  // },
  // handleResult(rawData) {
  //   // console.log(rawData)
  //   let ids = new Set()
  //   const list = []
  //   rawData.forEach(item => {
  //     if (ids.has(item.id)) return
  //     ids.add(item.id)
  //     const types = []
  //     const _types = {}
  //     item.newRateFormats && item.newRateFormats.forEach(type => {
  //       let size
  //       switch (type.formatType) {
  //         case 'PQ':
  //           size = sizeFormate(type.size ?? type.androidSize)
  //           types.push({ type: '128k', size })
  //           _types['128k'] = {
  //             size,
  //           }
  //           break
  //         case 'HQ':
  //           size = sizeFormate(type.size ?? type.androidSize)
  //           types.push({ type: '320k', size })
  //           _types['320k'] = {
  //             size,
  //           }
  //           break
  //         case 'SQ':
  //           size = sizeFormate(type.size ?? type.androidSize)
  //           types.push({ type: 'flac', size })
  //           _types.flac = {
  //             size,
  //           }
  //           break
  //         case 'ZQ':
  //           size = sizeFormate(type.size ?? type.androidSize)
  //           types.push({ type: 'flac24bit', size })
  //           _types.flac24bit = {
  //             size,
  //           }
  //           break
  //       }
  //     })
  //     const albumNInfo = item.albums && item.albums.length
  //       ? {
  //           id: item.albums[0].id,
  //           name: item.albums[0].name,
  //         }
  //       : {}
  //     list.push({
  //       singer: this.getSinger(item.singers),
  //       name: item.name,
  //       albumName: albumNInfo.name,
  //       albumId: albumNInfo.id,
  //       songmid: item.songId,
  //       copyrightId: item.copyrightId,
  //       source: 'mg',
  //       interval: null,
  //       img: item.imgItems && item.imgItems.length ? item.imgItems[0].img : null,
  //       lrc: null,
  //       lrcUrl: item.lyricUrl,
  //       mrcUrl: item.mrcurl,
  //       trcUrl: item.trcUrl,
  //       otherSource: null,
  //       types,
  //       _types,
  //       typeUrl: {},
  //     })
  //   })
  //   return list
  // },
  musicSearch(str, page, limit) {
    const time = Date.now().toString();
    const signData = createSignature(time, str);
    const searchRequest = httpFetch(`https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(str)}&pageNo=${page}&sort=0&sid=USS`, {
      headers: {
        uiVersion: "A_music_3.6.1",
        deviceId: signData.deviceId,
        timestamp: time,
        sign: signData.sign,
        channel: "0146921",
        "User-Agent": "Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30"
      }
    });
    return searchRequest.promise.then(({ body }) => body);
  },
  filterData(rawData) {
    const list = [];
    const ids = /* @__PURE__ */ new Set();
    rawData.forEach((item) => {
      item.forEach((data) => {
        if (!data.songId || !data.copyrightId || ids.has(data.copyrightId)) return;
        ids.add(data.copyrightId);
        const types = [];
        const _types = {};
        data.audioFormats && data.audioFormats.forEach((type) => {
          let size;
          switch (type.formatType) {
            case "PQ":
              size = sizeFormate(type.asize ?? type.isize);
              types.push({ type: "128k", size });
              _types["128k"] = {
                size
              };
              break;
            case "HQ":
              size = sizeFormate(type.asize ?? type.isize);
              types.push({ type: "320k", size });
              _types["320k"] = {
                size
              };
              break;
            case "SQ":
              size = sizeFormate(type.asize ?? type.isize);
              types.push({ type: "flac", size });
              _types.flac = {
                size
              };
              break;
            case "ZQ24":
              size = sizeFormate(type.asize ?? type.isize);
              types.push({ type: "flac24bit", size });
              _types.flac24bit = {
                size
              };
              break;
          }
        });
        let img = data.img3 || data.img2 || data.img1 || null;
        if (img && !/https?:/.test(data.img3)) img = "http://d.musicapp.migu.cn" + img;
        list.push({
          singer: formatSingerName(data.singerList),
          name: data.name,
          albumName: data.album,
          albumId: data.albumId,
          songmid: data.songId,
          copyrightId: data.copyrightId,
          source: "mg",
          interval: formatPlayTime(data.duration),
          img,
          lrc: null,
          lrcUrl: data.lrcUrl,
          mrcUrl: data.mrcurl,
          trcUrl: data.trcUrl,
          types,
          _types,
          typeUrl: {}
        });
      });
    });
    return list;
  },
  search(str, page = 1, limit, retryNum = 0) {
    if (++retryNum > 3) return Promise.reject(new Error("try max num"));
    if (limit == null) limit = this.limit;
    return this.musicSearch(str, page, limit).then((result) => {
      if (!result || result.code !== "000000") return Promise.reject(new Error(result ? result.info : "\u641C\u7D22\u5931\u8D25"));
      const songResultData = result.songResultData || { resultList: [], totalCount: 0 };
      let list = this.filterData(songResultData.resultList);
      if (list == null) return this.search(str, page, limit, retryNum);
      this.total = parseInt(songResultData.totalCount);
      this.page = page;
      this.allPage = Math.ceil(this.total / limit);
      return {
        list,
        allPage: this.allPage,
        limit,
        total: this.total,
        source: "mg"
      };
    });
  }
};

// p:/MusicHub/源码/lx-music-desktop-master/src/renderer/utils/musicSdk/mg/songList.js
var songList_default5 = {
  _requestObj_tags: null,
  _requestObj_list: null,
  limit_list: 30,
  limit_song: 50,
  successCode: "000000",
  cachedDetailInfo: {},
  cachedUrl: {},
  sortList: [
    {
      name: "\u63A8\u8350",
      id: "15127315"
      // id: '1',
    }
    // {
    //   name: '最新',
    //   id: '15127272',
    //   // id: '2',
    // },
  ],
  regExps: {
    list: /<li><div class="thumb">.+?<\/li>/g,
    listInfo: /.+data-original="(.+?)".*data-id="(\d+)".*<div class="song-list-name"><a\s.*?>(.+?)<\/a>.+<i class="iconfont cf-bofangliang"><\/i>(.+?)<\/div>/,
    // https://music.migu.cn/v3/music/playlist/161044573?page=1
    listDetailLink: /^.+\/playlist\/(\d+)(?:\?.*|&.*$|#.*$|$)/
  },
  tagsUrl: "https://app.c.nf.migu.cn/pc/v1.0/template/musiclistplaza-taglist/release",
  // tagsUrl: 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/indexTagPage.do?needAll=0',
  getSongListUrl(sortId, tagId, page) {
    if (!tagId) {
      return `https://app.c.nf.migu.cn/pc/bmw/page-data/playlist-square-recommend/v1.0?templateVersion=2&pageNo=${page}`;
    }
    return `https://app.c.nf.migu.cn/pc/v1.0/template/musiclistplaza-listbytag/release?pageNumber=${page}&templateVersion=2&tagId=${tagId}`;
  },
  getSongListDetailUrl(id, page) {
    return `https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?pageNo=${page}&pageSize=${this.limit_song}&playlistId=${id}`;
  },
  defaultHeaders: {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1",
    Referer: "https://m.music.migu.cn/"
    // language: 'Chinese',
    // ua: 'Android_migu',
    // mode: 'android',
    // version: '6.8.5',
  },
  getListDetailList(id, page, tryNum = 0) {
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    const requestObj_listDetail = httpFetch(this.getSongListDetailUrl(id, page), { headers: this.defaultHeaders });
    return requestObj_listDetail.promise.then(({ body }) => {
      if (body.code !== this.successCode) return this.getListDetailList(id, page, ++tryNum);
      return {
        list: filterMusicInfoListV5(body.data.songList),
        page,
        limit: this.limit_song,
        total: body.data.totalCount,
        source: "mg"
      };
    });
  },
  getListDetailInfo(id, tryNum = 0) {
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    if (this.cachedDetailInfo[id]) return Promise.resolve(this.cachedDetailInfo[id]);
    const requestObj_listDetailInfo = httpFetch(`https://c.musicapp.migu.cn/MIGUM3.0/resource/playlist/v2.0?playlistId=${id}`, {
      headers: this.defaultHeaders
    });
    return requestObj_listDetailInfo.promise.then(({ body }) => {
      if (body.code !== this.successCode) return this.getListDetail(id, ++tryNum);
      const cachedDetailInfo = this.cachedDetailInfo[id] = {
        name: body.data.title,
        img: body.data.imgItem.img,
        desc: body.data.summary,
        author: body.data.ownerName,
        play_count: formatPlayCount(body.data.opNumItem.playNum)
      };
      return cachedDetailInfo;
    });
  },
  async getDetailUrl(link, page, retryNum = 0) {
    if (retryNum > 3) return Promise.reject(new Error("link try max num"));
    const requestObj_listDetailLink = httpFetch(link, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1",
        Referer: link
      }
    });
    const { headers: { location }, statusCode } = await requestObj_listDetailLink.promise;
    if (statusCode > 400) return this.getDetailUrl(link, page, ++retryNum);
    if (location) {
      this.cachedUrl[link] = location;
      return this.getListDetail(location, page);
    }
    return Promise.reject(new Error("link get failed"));
  },
  getListDetail(id, page, retryNum = 0) {
    var _a;
    if (/\/playlist[/?]/.test(id)) {
      id = (_a = /(?:playlistId|id)=(\d+)/.exec(id)) == null ? void 0 : _a[1];
      if (!id) throw new Error("list detail id parse failed");
    } else if (this.regExps.listDetailLink.test(id)) {
      id = id.replace(this.regExps.listDetailLink, "$1");
    } else if (/[?&:/]/.test(id)) {
      const url = this.cachedUrl[id];
      return url ? this.getListDetail(url, page) : this.getDetailUrl(id, page);
    }
    return Promise.all([
      this.getListDetailList(id, page, retryNum),
      this.getListDetailInfo(id, retryNum)
    ]).then(([listData, info]) => {
      listData.info = info;
      return listData;
    });
  },
  // 获取列表数据
  getList(sortId, tagId, page, tryNum = 0) {
    if (this._requestObj_list) this._requestObj_list.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_list = httpFetch(this.getSongListUrl(sortId, tagId, page), {
      headers: this.defaultHeaders
      // headers: {
      //   sign: 'c3b7ae985e2206e97f1b2de8f88691e2',
      //   timestamp: 1578225871982,
      //   appId: 'yyapp2',
      //   mode: 'android',
      //   ua: 'Android_migu',
      //   version: '6.9.4',
      //   osVersion: 'android 7.0',
      //   'User-Agent': 'okhttp/3.9.1',
      // },
    });
    return this._requestObj_list.promise.then(({ body }) => {
      if (body.code !== "000000") return this.getList(sortId, tagId, page, ++tryNum);
      const list = body.data.contents ? this.filterList2(body.data.contents) : this.filterList(body.data.contentItemList[1].itemList);
      return {
        list,
        total: 99999,
        page,
        limit: this.limit_list,
        source: "mg"
      };
    });
  },
  filterList2(listData, list = [], ids = /* @__PURE__ */ new Set()) {
    for (const item of listData) {
      if (item.contents) this.filterList2(item.contents, list, ids);
      else if (item.resType == "2021" && !ids.has(item.resId)) {
        ids.add(item.resId);
        list.push({
          id: String(item.resId),
          author: "",
          name: item.txt,
          // time: dateFormat(item.createTime, 'Y-M-D'),
          img: item.img,
          // grade: item.grade,
          // total: item.contentCount,
          desc: item.txt2,
          source: "mg"
        });
      }
    }
    return list;
  },
  filterList(rawData) {
    return rawData.map((item) => {
      var _a;
      return {
        play_count: (_a = item.barList[0]) == null ? void 0 : _a.title,
        id: String(item.logEvent.contentId),
        author: "",
        name: item.title,
        // time: dateFormat(item.createTime, 'Y-M-D'),
        img: item.imageUrl,
        // grade: item.grade,
        // total: item.contentCount,
        desc: "",
        source: "mg"
      };
    });
  },
  // 获取标签
  getTag(tryNum = 0) {
    if (this._requestObj_tags) this._requestObj_tags.cancelHttp();
    if (tryNum > 2) return Promise.reject(new Error("try max num"));
    this._requestObj_tags = httpFetch(this.tagsUrl, { headers: this.defaultHeaders });
    return this._requestObj_tags.promise.then(({ body }) => {
      if (body.code !== this.successCode) return this.getTag(++tryNum);
      return this.filterTagInfo(body.data);
    });
  },
  filterTagInfo(rawList) {
    return {
      hotTag: rawList[0].content.map(({ texts: [name, id] }) => ({
        id,
        name,
        source: "mg"
      })),
      tags: rawList.slice(1).map(({ header, content }) => ({
        name: header.title,
        list: content.map(({ texts: [name, id] }) => ({
          // parent_id: objectInfo.columnId,
          // parent_name: objectInfo.columnTitle,
          id,
          name,
          source: "mg"
        }))
      })),
      source: "mg"
    };
  },
  getTags() {
    return this.getTag();
  },
  getDetailPageUrl(id) {
    if (/playlist\/index\.html\?/.test(id)) {
      id = id.replace(/.*(?:\?|&)id=(\d+)(?:&.*|$)/, "$1");
    } else if (this.regExps.listDetailLink.test(id)) {
      id = id.replace(this.regExps.listDetailLink, "$1");
    }
    return `https://music.migu.cn/v3/music/playlist/${id}`;
  },
  filterSongListResult(raw) {
    const list = [];
    raw.forEach((item) => {
      if (!item.id) return;
      const playCount = parseInt(item.playNum);
      list.push({
        play_count: isNaN(playCount) ? 0 : formatPlayCount(playCount),
        id: item.id,
        author: item.userName,
        name: item.name,
        img: item.musicListPicUrl,
        total: item.musicNum,
        source: "mg"
      });
    });
    return list;
  },
  search(text, page, limit = 20) {
    const timeStr = Date.now().toString();
    const signResult = createSignature(timeStr, text);
    return createHttpFetch(`https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=1&isCopyright=1&searchSwitch=%7B%22song%22%3A0%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A0%2C%22mvSong%22%3A0%2C%22bestShow%22%3A0%2C%22songlist%22%3A1%2C%22lyricSong%22%3A0%7D&pageSize=${limit}&text=${encodeURIComponent(text)}&pageNo=${page}&sort=0&sid=USS`, {
      headers: {
        uiVersion: "A_music_3.6.1",
        deviceId: signResult.deviceId,
        timestamp: timeStr,
        sign: signResult.sign,
        channel: "0146921",
        "User-Agent": "Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30"
      }
    }).then((body) => {
      if (!body.songListResultData) throw new Error("get song list faild.");
      const list = this.filterSongListResult(body.songListResultData.result);
      return {
        list,
        limit,
        total: parseInt(body.songListResultData.totalCount),
        source: "mg"
      };
    });
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  kgLeaderboard,
  kgMusicSearch,
  kgSongList,
  kwLeaderboard,
  kwMusicSearch,
  kwSongList,
  mgLeaderboard,
  mgMusicSearch,
  mgSongList,
  txLeaderboard,
  txMusicSearch,
  txSongList,
  wyLeaderboard,
  wyMusicSearch,
  wySongList
});
