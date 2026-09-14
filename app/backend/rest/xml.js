'use strict';

/**
 * 轻量 XML 序列化器，用于 OpenSubsonic 的 f=xml 响应。
 * OpenSubsonic 实体基本全部是「属性」形态（<child id=".." title=".."/>），
 * 嵌套列表（如 album 下的 <song/>）通过 children 渲染。
 */

function escape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 属性值是否为「无值」：null / undefined / 空字符串（实体字段无值时省略）
 */
function isOmitted(value) {
  return value === null || value === undefined || value === '';
}

function attrValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * 渲染一个纯属性实体：<name a="1" b="2"/>
 * @param {string} name
 * @param {object} attrs - 键值对；无值(null/undefined/'') 的属性被省略
 */
function entity(name, attrs) {
  let out = `<${name}`;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (isOmitted(v)) continue;
    out += ` ${k}="${escape(attrValue(v))}"`;
  }
  out += '/>';
  return out;
}

/**
 * 渲染带子元素的节点：<name attrs>children</name>
 * @param {string} name
 * @param {object} attrs
 * @param {string} children - 已渲染的子元素字符串（可为空）
 */
function element(name, attrs, children) {
  let out = `<${name}`;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (isOmitted(v)) continue;
    out += ` ${k}="${escape(attrValue(v))}"`;
  }
  if (children) {
    out += `>${children}</${name}>`;
  } else {
    out += '/>';
  }
  return out;
}

module.exports = { escape, entity, element, isOmitted, attrValue };
