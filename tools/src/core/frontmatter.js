/**
 * 极简 YAML frontmatter 解析器，零依赖，正确处理中文。
 * 支持类型：字符串、数字、布尔、null、内联数组、块状数组、对象数组块。
 */

// ----------------------- 公用工具 -----------------------

/**
 * 转义 YAML 字符串中的特殊字符，并用双引号包裹。
 * @param {string} s
 * @returns {string}
 */
function escapeYamlString(s) {
  // 转义反斜杠和双引号
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * 判断值是否为对象（非 null 且非数组）
 * @param {*} value
 * @returns {boolean}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 将简单值序列化为 YAML 标量。
 * @param {*} val
 * @returns {string}
 */
function stringifyScalar(val) {
  if (val === null) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  // 字符串统一加双引号，防止中文等特殊字符引起解析错误
  return escapeYamlString(String(val));
}

/**
 * 将数组序列化为 YAML（内联或块状）
 * @param {Array} arr
 * @param {number} indent 缩进空格数
 * @returns {string}
 */
function stringifyArray(arr, indent = 0) {
  if (arr.length === 0) return '[]';

  // 全是简单值且短小 → 内联（调用方负责拼上 "key: "）
  const allSimple = arr.every((item) => !isObject(item));
  if (allSimple && arr.length <= 3) {
    return `[${arr.map((item) => stringifyScalar(item)).join(', ')}]`;
  }

  // 块状数组：每个元素一行，以 "- " 开头
  const prefix = ' '.repeat(indent);
  return arr
    .map((item) => {
      if (isObject(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) return `${prefix}- {}`;
        // 标准 YAML：首个字段跟在 "- " 之后，其余字段缩进对齐
        return entries
          .map(([k, v], idx) => {
            const entry = idx === 0 ? `${prefix}- ${k}` : `${prefix}  ${k}`;
            if (Array.isArray(v)) {
              const inline = v.length === 0 || (v.every((it) => !isObject(it)) && v.length <= 3);
              // 长数组必须换行缩进；写成 "key: - x" 不是合法 YAML，读回来会整棵树失效
              return inline
                ? `${entry}: ${stringifyArray(v, 0)}`
                : `${entry}:\n${stringifyArray(v, indent + 4)}`;
            }
            return `${entry}: ${stringifyScalar(v)}`;
          })
          .join('\n');
      }
      return `${prefix}- ${stringifyScalar(item)}`;
    })
    .join('\n');
}

/**
 * 将数据对象序列化为 YAML 字符串（不含 --- 边界）
 * @param {object} data
 * @returns {string}
 */
function stringifyYaml(data) {
  const lines = [];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`); // 空数组必须写在同一行,换行的 `[]` 不是合法 YAML
      } else if (value.every((it) => !isObject(it)) && value.length <= 3) {
        lines.push(`${key}: ${stringifyArray(value, 0)}`);
      } else {
        lines.push(`${key}:`);
        lines.push(stringifyArray(value, 2));
      }
    } else if (isObject(value)) {
      const entries = Object.entries(value);
      if (!entries.length) {
        lines.push(`${key}: {}`);
        continue;
      }
      lines.push(`${key}:`);
      for (const [k, v] of entries) {
        lines.push(`  ${k}: ${Array.isArray(v) ? stringifyArray(v, 4) : stringifyScalar(v)}`);
      }
    } else {
      lines.push(`${key}: ${stringifyScalar(value)}`);
    }
  }
  return lines.join('\n');
}

// ----------------------- 解析辅助 -----------------------

/**
 * 解析 YAML 内联值（字符串、数字、布尔、null、内联数组）
 * @param {string} raw
 * @returns {*}
 */
function parseInlineValue(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  // null
  if (trimmed === 'null' || trimmed === '~') return null;
  // 布尔
  if (trimmed === 'true' || trimmed === 'True' || trimmed === 'TRUE') return true;
  if (trimmed === 'false' || trimmed === 'False' || trimmed === 'FALSE') return false;
  // 数字
  if (/^-?\d+(\.\d+)?$/.test(trimmed) && !/^[+-]?\d+\.$/.test(trimmed)) {
    return Number(trimmed);
  }
  // 引号字符串（还原 stringifyScalar 做的转义）
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  // 空对象（stringifyYaml 对空对象写 `key: {}`）
  if (trimmed === '{}') return {};
  // 内联数组
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return []; // 空数组必须是 [],不能解析成 ['']
    return inner.split(',').map((s) => parseInlineValue(s.trim()));
  }
  // 普通字符串：保留原始内容（可能包含中文、冒号等）
  return trimmed;
}

/**
 * 解析块状数组（以缩进的 `- ` 开头的行），可以是简单列表或对象列表。
 * @param {string[]} lines 所有 YAML 行
 * @param {number} startIndex 当前顶层属性值开始的行索引
 * @returns {{ value: Array, nextIndex: number }}
 */
function parseBlockArray(lines, startIndex) {
  const result = [];
  let i = startIndex;
  let currentObj = null;
  let currentIndent = null;

  while (i < lines.length) {
    const line = lines[i];
    // 空行或纯空白行跳过
    if (line.trim() === '') {
      i++;
      continue;
    }
    const indent = line.search(/\S/);
    if (currentIndent === null) {
      // 通过第一个非空行确定数组项基准缩进
      currentIndent = indent;
      if (!line.trimStart().startsWith('- ')) {
        // 不符合数组格式，终止解析
        break;
      }
    } else if (indent < currentIndent) {
      // 缩进减小，说明块状数组结束
      break;
    }

    const content = line.trimStart();
    if (content === '-') {
      // 裸的 "-"：对象项开始，字段在随后的缩进行里
      if (currentObj !== null) result.push(currentObj);
      currentObj = {};
      i++;
      continue;
    }
    if (content.startsWith('- ')) {
      // 上一个对象结束，保存
      if (currentObj !== null) {
        result.push(currentObj);
        currentObj = null;
      }
      const val = content.slice(2).trim();
      if (/^[^:]+:\s*$/.test(val)) {
        // 对象开始，且第一个字段是嵌套块数组： "- key:" 后跟缩进的 "- x"
        currentObj = {};
        const key = val.slice(0, val.lastIndexOf(':')).trim();
        const nested = parseBlockArray(lines, i + 1);
        currentObj[key] = nested.value;
        i = nested.nextIndex;
        continue;
      }
      if (val.includes(': ')) {
        // 对象项开始：解析内联键值对，如 "- name: Alice"
        currentObj = {};
        const [k, v] = splitKeyValue(val);
        currentObj[k] = parseInlineValue(v);
      } else {
        // 简单项：直接存储
        const simpleVal = parseInlineValue(val);
        result.push(simpleVal);
      }
    } else if (currentObj !== null && content) {
      // 属于当前对象的多字段
      if (content.includes(': ')) {
        const [k, v] = splitKeyValue(content);
        currentObj[k] = parseInlineValue(v);
      } else if (/^[^:]+:\s*$/.test(content)) {
        // 嵌套块数组： "key:" 后跟缩进的 "- x"
        const key = content.slice(0, content.lastIndexOf(':')).trim();
        const nested = parseBlockArray(lines, i + 1);
        currentObj[key] = nested.value;
        i = nested.nextIndex;
        continue;
      }
    } else {
      // 无法识别的格式，终止
      break;
    }
    i++;
  }
  // 最后一个对象
  if (currentObj !== null) result.push(currentObj);

  return { value: result, nextIndex: i };
}

/**
 * 解析块状对象（缩进的 `key: value` 行），目前只支持一层。
 * 与块状数组的区别：子行不以 "- " 开头。
 *
 * @param {string[]} lines 所有 YAML 行
 * @param {number} startIndex 当前顶层属性值开始的行索引
 * @returns {{ value: object, nextIndex: number }}
 */
function parseBlockObject(lines, startIndex) {
  const result = {};
  let i = startIndex;
  let baseIndent = null;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const indent = line.search(/\S/);
    if (indent === 0) break;
    if (baseIndent === null) baseIndent = indent;
    if (indent < baseIndent) break;

    const content = line.trim();
    if (content.startsWith('- ')) break; // 实际是数组，交给调用方判断
    if (content.includes(':')) {
      const [k, v] = splitKeyValue(content);
      result[k] = parseInlineValue(v);
    }
    i++;
  }

  return { value: result, nextIndex: i };
}

/**
 * 将 "键: 值" 行拆分，正确处理值内部的冒号。
 * @param {string} line
 * @returns {[string, string]}
 */
function splitKeyValue(line) {
  const idx = line.indexOf(':');
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  return [key, value];
}

/**
 * 解析 markdown 中的 YAML frontmatter。
 *
 * @param {string} markdown 完整 markdown 文本
 * @returns {{ data: object, content: string }} 解析出的数据部分和正文部分
 */
export function parse(markdown) {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) {
    // 无 frontmatter
    return { data: {}, content: markdown };
  }

  // 去除开头的 ---
  const afterStart = trimmed.slice(3);
  const endIdx = afterStart.indexOf('\n---');
  if (endIdx === -1) {
    // 没有结束标记，整体视为无 frontmatter
    return { data: {}, content: markdown };
  }

  const yamlStr = afterStart.slice(0, endIdx);
  const content = afterStart.slice(endIdx + 4); // 跳过 '\n---'

  const lines = yamlStr.split('\n');
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 空行跳过
    if (line.trim() === '') {
      i++;
      continue;
    }
    // 检测顶层属性（缩进为0）
    if (line.search(/\S/) === 0) {
      const kv = splitKeyValue(line);
      const key = kv[0];
      const value = kv[1];

      if (value === '') {
        // 值部分为空：后面可能是块状数组（- x），也可能是一层嵌套对象（k: v）
        const nextLine = lines.slice(i + 1).find((line) => line.trim() !== '');
        const isObjectBlock = Boolean(nextLine)
          && nextLine.search(/\S/) > 0
          && !nextLine.trimStart().startsWith('- ');
        if (isObjectBlock) {
          const { value: objectValue, nextIndex } = parseBlockObject(lines, i + 1);
          data[key] = objectValue;
          i = nextIndex;
        } else {
          const { value: arrayValue, nextIndex } = parseBlockArray(lines, i + 1);
          data[key] = arrayValue;
          i = nextIndex;
        }
      } else {
        // 内联值
        data[key] = parseInlineValue(value);
        i++;
      }
    } else {
      // 非0缩进行，应归属于上一个顶层块，但 most cases 前面已被处理
      i++;
    }
  }

  return { data, content };
}

/**
 * 将数据和内容序列化为完整 markdown 字符串（即带 YAML frontmatter）。
 * 自动选择合适的数组格式（短小简单数组内联，对象数组块状）。
 *
 * @param {object} data 要写入 frontmatter 的数据
 * @param {string} content 正文内容
 * @returns {string} 完整 markdown
 */
export function stringify(data, content) {
  const yamlBody = stringifyYaml(data);
  const frontmatter = `---\n${yamlBody}\n---`;
  // 如果正文已有前导换行，避免多余空行
  const separator = content.startsWith('\n') ? '' : '\n';
  return `${frontmatter}${separator}${content}`;
}
