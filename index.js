/**
 * dsh-skill-manager — Host half.
 *
 * 统一扫描本机各软件（DSH / Claude Code / Codex / Cursor / 自动发现）的技能库，
 * 提供中文简介与适用场景（Host translator 服务 + 本地缓存）、场景分类、跨库复制、
 * 回收站删除、仓库地址识别与安装，并通过 /skill-manager/api 前缀路由提供给
 * Client 半（工作台 + 对话框技能选择器）。
 *
 * 约定：本文件不 import 包内其它模块；状态持久化在 ~/.dsh/skill-manager/state.json。
 */

import { promises as fsp } from 'node:fs'
import { join, resolve, sep, basename, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'

export const inject = ['webServer']

/** apply() 时写入；供状态读写、日志、可选服务访问使用。 */
let ctxRef = null

// ── 常量 ────────────────────────────────────────────────────────────────

const API_PREFIX = '/skill-manager/api'
const SCAN_TTL_MS = 30_000
const LIB_DISCOVERY_TTL_MS = 60_000
const SKILL_LIST_MAX = 600
const FM_HEAD_BYTES = 8192
const DETAIL_MAX_BYTES = 128 * 1024
const BODY_MAX_BYTES = 256 * 1024
const DESCRIPTION_MAX = 600
const TRANSLATE_TEXT_MAX = 900
const TRANSLATE_BATCH_MAX = 8
const REPO_SKILL_MAX = 200
const REPO_META_FETCH_MAX = 80
const INSTALL_FILE_MAX = 300
const INSTALL_FILE_BYTES_MAX = 2 * 1024 * 1024
const INSTALL_TOTAL_BYTES_MAX = 80 * 1024 * 1024
const COPY_FILE_MAX = 6000
const COPY_BYTES_MAX = 600 * 1024 * 1024
const NET_TIMEOUT_MS = 15_000

const HOME = homedir()
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')
const MANAGER_DIR = join(DSH_HOME, 'skill-manager')
const STATE_FILE = join(MANAGER_DIR, 'state.json')
const TRASH_DIR = join(MANAGER_DIR, 'trash')

const STATE_VERSION = 6

/** 内置分类只保留兜底；其它分类由「自动整理」根据本机实际技能生成。 */
const DEFAULT_CATEGORIES = [
  { id: 'default', name: '默认分类', builtin: true, order: 0, keywords: [] },
]

/**
 * 主题字典：自动整理时扫描本机技能，命中数够的主题才创建分类。
 * 顺序即优先级（先匹配到的主题胜出）；英文关键词按词边界匹配，中文按子串。
 */
const TOPIC_DEFS = [
  { id: 'dingtalk', name: '钉钉办公', keywords: ['钉钉', 'dingtalk', 'dws'] },
  { id: '3d-print', name: '3D 打印', keywords: ['3d打印', '打印', '切片', 'gcode', 'orca', 'bambu', 'slicer', 'printer', 'prusa', 'creality', 'dfam', '支撑', '挤出'] },
  { id: 'cad', name: 'CAD 与制造', keywords: ['cad', '建模', 'step', 'stp', 'stl', '3mf', 'dxf', '工程图', 'parametric', 'freecad', 'blender', 'mesh', 'urdf', 'srdf', 'sdf', '机器人', 'robot', '几何', 'dfm', 'dfam', '制造', 'manufacturing', 'cnc', 'machining', '注塑', '钣金', '加工'] },
  { id: 'video', name: '视频创作', keywords: ['视频', '剪辑', '剪映', 'jianying', 'ffmpeg', 'ffprobe', '字幕', 'subtitle', '配音', '分镜', 'storyboard', '动画', 'animation', '录屏'] },
  { id: 'office', name: '文档处理', keywords: ['docx', 'xlsx', 'pptx', 'pdf', 'word', 'excel', 'powerpoint', 'office', '文档', '表格', '演示', 'markdown', 'ocr'] },
  { id: 'image', name: '图片处理', keywords: ['图片', 'image', '图像', '截图', 'screenshot', 'photoshop', '修图', '抠图'] },
  { id: 'audio', name: '音频处理', keywords: ['音频', 'audio', '语音', 'voice', 'tts', 'stt', '播客', 'podcast'] },
  { id: 'design', name: '前端与设计', keywords: ['设计', 'design', 'ui', 'ux', 'frontend', '前端', 'css', 'html', '界面', 'figma', '海报', '品牌', 'brand', 'taste', 'landing'] },
  { id: 'test', name: '测试与质量', keywords: ['jest', 'vitest', 'pytest', 'e2e', '回归测试', 'qa', '测试'] },
  { id: 'security', name: '安全与审计', keywords: ['安全', 'security', '漏洞', 'vuln', '审计', 'audit', 'encryption', '加密'] },
  { id: 'devops', name: '运维部署', keywords: ['docker', 'kubernetes', 'k8s', '部署', 'deploy', '运维', 'nginx', 'linux', '服务器'] },
  { id: 'browser', name: '浏览器自动化', keywords: ['browser', '浏览器', 'playwright', 'web-access', '网页', '抓取', 'scrape'] },
  { id: 'data', name: '数据处理', keywords: ['database', '数据库', 'sql', '数据分析', 'analytics', '统计', 'csv'] },
  { id: 'code', name: '编码开发', keywords: ['编码', '代码', '编程', 'code', 'coding', 'developer', 'git', 'github', 'gitlab', 'debug', 'refactor', '重构', 'ci', '构建', '编译', '命令行', 'terminal', 'shell', '脚本', 'script', 'python', 'javascript', 'typescript', '开发'] },
  { id: 'ai', name: 'AI 与智能体', keywords: ['prompt', '提示词', 'agent', '智能体', 'context', 'token', 'eval', '评测', 'reasoning', 'subagent', 'workflow', 'llm', '大模型'] },
  { id: 'integration', name: 'MCP 与集成', keywords: ['mcp', 'connector', '连接器', 'oauth', 'api', 'webhook', '集成', '飞书', 'slack'] },
  { id: 'writing', name: '写作与文案', keywords: ['写作', '文案', 'copywriting', 'blog', '文章', '报告', '邮件', 'mail'] },
  { id: 'automation', name: '自动化', keywords: ['自动化', 'automation', '定时', 'schedule', 'cron'] },
  { id: 'skilldev', name: '技能与插件开发', keywords: ['skill', '技能', 'plugin', '插件', 'cordis'] },
]

/** 一个主题至少命中这么多技能才单独建分类。 */
const MIN_TOPIC_SKILLS = 3

const KNOWN_LABELS = {
  dsh: 'DSH',
  claude: 'Claude Code',
  codex: 'Codex',
  agents: 'Agents',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  windsurf: 'Windsurf',
  trae: 'Trae',
  qoder: 'Qoder',
  zcode: 'ZCode',
  copilot: 'GitHub Copilot',
  continue: 'Continue',
  cline: 'Cline',
  roo: 'Roo Code',
  opencode: 'OpenCode',
  crush: 'Crush',
  amp: 'Amp',
  aider: 'Aider',
  goose: 'Goose',
}

// ── 小工具 ──────────────────────────────────────────────────────────────

function httpError(status, message, code) {
  const err = new Error(message)
  err.status = status
  err.code = code || 'INTERNAL'
  return err
}

function sha1(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex')
}

function clampText(text, max) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return value.length > max ? value.slice(0, max) : value
}

function displayPath(target) {
  const value = String(target)
  if (value.toLowerCase().startsWith(HOME.toLowerCase())) return '~' + value.slice(HOME.length)
  return value
}

function normPathKey(target) {
  const value = resolve(String(target))
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function isCJK(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(String(text || ''))
}

function cjkRatio(text) {
  const value = String(text || '')
  if (value === '') return 0
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  return cjk / value.length
}

function needsTranslation(text) {
  const value = String(text || '').trim()
  if (value === '') return false
  return cjkRatio(value) < 0.2
}

function slugLabel(name) {
  const key = String(name).replace(/^\.+/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return key
}

function prettyLabel(key) {
  if (KNOWN_LABELS[key]) return KNOWN_LABELS[key]
  return String(key).split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function safeSkillDirName(name) {
  const value = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-')
  if (value === '' || value === '.' || value === '..' || value.startsWith('.')) return ''
  return value
}

function trashId() {
  return `${Date.now()}-${randomBytes(3).toString('hex')}`
}

function validTrashId(id) {
  return typeof id === 'string' && /^\d{1,16}-[0-9a-f]{6}$/.test(id)
}

function truncateUtf8(text, maxBytes) {
  const value = String(text || '')
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false }
  let out = value.slice(0, maxBytes)
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -1)
  return { text: out, truncated: true }
}

async function readJsonFile(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

async function renameWithFallback(from, to) {
  try {
    await fsp.rename(from, to)
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      await fsp.cp(from, to, { recursive: true })
      await fsp.rm(from, { recursive: true, force: true })
      return
    }
    throw err
  }
}

// ── 状态 ────────────────────────────────────────────────────────────────

function defaultState() {
  return {
    version: STATE_VERSION,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c, keywords: c.keywords.slice() })),
    assignments: {},
    overrides: {},
    translations: {},
    aliases: {},
    repoAliases: {},
    repos: [],
    installs: {},
    autoOrganizedAt: 0,
    settings: {
      autoTranslate: true,
      autoClassify: true,
      translateProvider: 'auto',
      disabledLibraries: [],
      customLibraries: [],
    },
  }
}

let state = defaultState()
let stateLoaded = false
let saveTimer = null
let saveChain = Promise.resolve()

function normalizeState(input) {
  const base = defaultState()
  if (!input || typeof input !== 'object') return base
  const merged = { ...base, ...input }
  const previousVersion = typeof input.version === 'number' ? input.version : 1
  if (!Array.isArray(merged.categories) || merged.categories.length === 0) merged.categories = base.categories
  // v5：分类改为「按本机实际技能自动生成」—— 清掉旧的内置/自动分类，只保留默认分类与用户自建分类
  if (previousVersion < 5) {
    const kept = merged.categories.filter((c) => c && typeof c.id === 'string' && (c.id === 'default' || (c.builtin !== true && c.auto !== true)))
    const keptIds = new Set(kept.map((c) => c.id))
    merged.categories = kept
    const assignments = merged.assignments && typeof merged.assignments === 'object' ? merged.assignments : {}
    for (const key of Object.keys(assignments)) {
      if (!keptIds.has(assignments[key])) delete assignments[key]
    }
    merged.assignments = assignments
    merged.autoOrganizedAt = 0
  }
  // v6：自动分类的排序改为与主题字典一致，重新生成一次
  if (previousVersion < 6) {
    const removedIds = new Set()
    merged.categories = merged.categories.filter((c) => {
      if (c && c.auto === true) { removedIds.add(c.id); return false }
      return true
    })
    const assignments = merged.assignments && typeof merged.assignments === 'object' ? merged.assignments : {}
    for (const key of Object.keys(assignments)) {
      if (removedIds.has(assignments[key])) delete assignments[key]
    }
    merged.assignments = assignments
    merged.autoOrganizedAt = 0
  }
  // 只保证「默认分类」始终存在；其它分类可被用户删改，不在加载时复活
  if (!merged.categories.some((c) => c && c.id === 'default')) merged.categories.unshift({ ...DEFAULT_CATEGORIES[0] })
  merged.categories = merged.categories
    .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
    .map((c, index) => ({
      id: c.id,
      name: c.name,
      builtin: c.id === 'default' ? true : c.builtin === true,
      auto: c.auto === true,
      order: typeof c.order === 'number' ? c.order : index + 5,
      keywords: Array.isArray(c.keywords) ? c.keywords.filter((k) => typeof k === 'string') : [],
    }))
    .sort((a, b) => a.order - b.order)
  merged.assignments = merged.assignments && typeof merged.assignments === 'object' ? merged.assignments : {}
  merged.overrides = merged.overrides && typeof merged.overrides === 'object' ? merged.overrides : {}
  merged.translations = merged.translations && typeof merged.translations === 'object' ? merged.translations : {}
  merged.aliases = merged.aliases && typeof merged.aliases === 'object' ? merged.aliases : {}
  merged.repoAliases = merged.repoAliases && typeof merged.repoAliases === 'object' ? merged.repoAliases : {}
  merged.repos = Array.isArray(merged.repos) ? merged.repos.filter((r) => r && typeof r.id === 'string') : []
  merged.installs = merged.installs && typeof merged.installs === 'object' ? merged.installs : {}
  merged.settings = { ...base.settings, ...(merged.settings && typeof merged.settings === 'object' ? merged.settings : {}) }
  if (!Array.isArray(merged.settings.disabledLibraries)) merged.settings.disabledLibraries = []
  if (!Array.isArray(merged.settings.customLibraries)) merged.settings.customLibraries = []
  merged.version = STATE_VERSION
  return merged
}

async function loadState() {
  if (stateLoaded) return state
  let raw
  try {
    raw = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'))
  } catch (err) {
    // ENOENT = 首次运行；其它错误先备份坏文件，绝不直接覆盖用户数据
    if (!err || err.code !== 'ENOENT') {
      try {
        await fsp.rename(STATE_FILE, `${STATE_FILE}.bad-${Date.now()}`)
      } catch {
        // 备份失败也要继续加载，但下面会记录日志
      }
      if (ctxRef && ctxRef.logger && typeof ctxRef.logger.warn === 'function') {
        ctxRef.logger.warn(`dsh-skill-manager: state.json 读取失败，已备份坏文件：${err && err.message ? err.message : err}`)
      }
    }
    raw = undefined
  }
  state = normalizeState(raw)
  stateLoaded = true
  return state
}

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveStateNow().catch(() => {})
  }, 120)
  if (typeof saveTimer.unref === 'function') saveTimer.unref()
}

async function saveStateNow() {
  saveChain = saveChain.then(async () => {
    try {
      await fsp.mkdir(MANAGER_DIR, { recursive: true })
      const tmp = `${STATE_FILE}.${process.pid}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
      await fsp.rename(tmp, STATE_FILE)
    } catch (err) {
      if (ctxRef && ctxRef.logger && typeof ctxRef.logger.warn === 'function') {
        ctxRef.logger.warn(`dsh-skill-manager: 状态保存失败：${err && err.message ? err.message : err}`)
      }
    }
  })
  return saveChain
}

// ── 技能库发现 ──────────────────────────────────────────────────────────

let libCache = { at: 0, libs: [] }

async function statDir(target) {
  try {
    const stat = await fsp.stat(target)
    return stat.isDirectory()
  } catch {
    return false
  }
}

async function discoverLibraries() {
  const now = Date.now()
  if (now - libCache.at < LIB_DISCOVERY_TTL_MS && libCache.libs.length > 0) return libCache.libs

  const found = []
  const seenDirs = new Set()
  const seenKeys = new Set()

  function push(lib) {
    const dirKey = normPathKey(lib.dir)
    if (seenDirs.has(dirKey)) return
    if (seenKeys.has(lib.key)) return
    seenDirs.add(dirKey)
    seenKeys.add(lib.key)
    found.push(lib)
  }

  // 1) 显式：约定覆盖不到的位置
  push({ key: 'dsh', label: KNOWN_LABELS.dsh, dir: join(DSH_HOME, 'skills'), writable: true, copyable: true, auto: false })
  push({ key: 'cursor', label: KNOWN_LABELS.cursor, dir: join(HOME, '.cursor', 'skills-cursor'), writable: true, copyable: true, auto: false })

  // 2) 约定发现：~/.<软件>/skills
  let homeEntries = []
  try {
    homeEntries = await fsp.readdir(HOME, { withFileTypes: true })
  } catch {
    homeEntries = []
  }
  const candidates = []
  for (const entry of homeEntries) {
    if (!entry.name || entry.name.length < 2 || !entry.name.startsWith('.')) continue
    if (entry.name === '.git' || entry.name === '.dsh') continue
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) isDir = await statDir(join(HOME, entry.name))
    if (!isDir) continue
    const key = slugLabel(entry.name)
    if (key === '') continue
    candidates.push({ key, label: prettyLabel(key), dir: join(HOME, entry.name, 'skills'), sort: entry.name })
  }
  candidates.sort((a, b) => a.sort.localeCompare(b.sort))
  for (const item of candidates) {
    if (seenKeys.has(item.key)) continue
    if (!(await statDir(item.dir))) continue
    push({ key: item.key, label: item.label, dir: item.dir, writable: true, copyable: true, auto: true })
  }

  // 3) 自定义库
  for (const custom of state.settings.customLibraries) {
    if (!custom || typeof custom.dir !== 'string' || custom.dir === '') continue
    const key = slugLabel(custom.key || basename(custom.dir))
    if (key === '') continue
    push({
      key,
      label: typeof custom.label === 'string' && custom.label !== '' ? custom.label : prettyLabel(key),
      dir: resolve(custom.dir.replace(/^~(?=$|[\\/])/, HOME)),
      writable: true,
      copyable: true,
      auto: false,
      custom: true,
    })
  }

  const disabled = new Set(state.settings.disabledLibraries || [])
  const libs = []
  for (const lib of found) {
    if (disabled.has(lib.key)) continue
    const present = await statDir(lib.dir)
    libs.push({ ...lib, present })
  }

  libCache = { at: now, libs }
  return libs
}

function findLibrary(key) {
  return libCache.libs.find((lib) => lib.key === key)
}

// ── SKILL.md 解析 ───────────────────────────────────────────────────────

function parseFrontmatter(text) {
  const source = String(text || '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (!match) return {}
  const lines = match[1].split(/\r?\n/)
  const out = {}
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    if (/^\s/.test(line)) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    if (!/^[A-Za-z_][\w-]*$/.test(key)) continue
    let value = line.slice(idx + 1).trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts = []
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^\s+\S/.test(lines[j])) {
          parts.push(lines[j].trim())
          i = j
        } else break
      }
      value = parts.join(' ')
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    value = value.replace(/\\"/g, '"').replace(/\\n/g, ' ')
    if (value !== '') out[key] = value
  }
  return out
}

async function readFrontmatter(dir) {
  const file = join(dir, 'SKILL.md')
  let handle
  try {
    handle = await fsp.open(file, 'r')
    const buffer = Buffer.alloc(FM_HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, FM_HEAD_BYTES, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    const meta = parseFrontmatter(head)
    const stat = await handle.stat()
    return { meta, mtime: stat.mtimeMs }
  } catch {
    return undefined
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // ignore
      }
    }
  }
}

function skillFromMeta(lib, dir, relPath, meta, mtime) {
  const fallbackName = basename(relPath)
  const rawName = typeof meta.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : fallbackName
  const name = rawName.replace(/^["']|["']$/g, '')
  return {
    key: `${lib.key}::${relPath.split(sep).join('/')}`,
    lib: lib.key,
    libLabel: lib.label,
    relPath: relPath.split(sep).join('/'),
    dir,
    name,
    description: clampText(meta.description, DESCRIPTION_MAX),
    whenToUse: clampText(meta.whenToUse || meta.when_to_use, 400),
    mtime: typeof mtime === 'number' ? mtime : 0,
    invocable: lib.key === 'dsh' || lib.key === 'dsh-builtin',
  }
}

async function scanSkillDir(lib, dir, relPath, depth) {
  if (depth > 2) return []
  const meta = await readFrontmatter(dir)
  if (meta) return [skillFromMeta(lib, dir, relPath, meta.meta, meta.mtime)]
  if (depth === 2) return []
  let entries = []
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
    const childDir = join(dir, entry.name)
    const childMeta = await readFrontmatter(childDir)
    if (childMeta) out.push(skillFromMeta(lib, childDir, join(relPath, entry.name), childMeta.meta, childMeta.mtime))
    if (out.length >= SKILL_LIST_MAX) break
  }
  return out
}

async function scanLibrary(lib) {
  const row = {
    key: lib.key,
    label: lib.label,
    dir: lib.dir,
    displayDir: displayPath(lib.dir),
    writable: lib.writable === true,
    copyable: lib.copyable === true,
    present: lib.present === true,
    count: 0,
    error: null,
    auto: lib.auto === true,
  }
  if (!row.present) return { row, skills: [] }
  const skills = []
  let entries = []
  try {
    entries = await fsp.readdir(lib.dir, { withFileTypes: true })
  } catch (err) {
    row.error = `无法读取目录：${err && err.message ? err.message : err}`
    return { row, skills }
  }
  for (const entry of entries) {
    if (skills.length >= SKILL_LIST_MAX) break
    if (entry.name.startsWith('.')) continue
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) isDir = await statDir(join(lib.dir, entry.name))
    if (!isDir) continue
    const dir = join(lib.dir, entry.name)
    const found = await scanSkillDir(lib, dir, entry.name, 1)
    for (const skill of found) {
      if (skills.length >= SKILL_LIST_MAX) break
      skills.push(skill)
    }
  }
  row.count = skills.length
  return { row, skills }
}

async function scanBuiltinSkills() {
  const row = {
    key: 'dsh-builtin',
    label: 'DSH 内置技能',
    dir: '',
    displayDir: '随 DSH 安装包（只读）',
    writable: false,
    copyable: false,
    present: true,
    count: 0,
    error: null,
    auto: false,
  }
  const skills = []
  try {
    const skillsSvc = ctxRef.get('skills')
    if (skillsSvc && typeof skillsSvc.list === 'function') {
      const list = await skillsSvc.list({})
      for (const item of Array.isArray(list) ? list : []) {
        if (!item || item.source !== 'bundled') continue
        if (skills.length >= SKILL_LIST_MAX) break
        const filePath = typeof item.path === 'string' ? item.path : ''
        const dir = filePath !== '' ? dirname(filePath) : ''
        const relPath = typeof item.name === 'string' && item.name !== '' ? item.name : basename(dir)
        skills.push({
          key: `dsh-builtin::${relPath}`,
          lib: 'dsh-builtin',
          libLabel: row.label,
          relPath,
          dir,
          name: item.name || relPath,
          description: clampText(item.description, DESCRIPTION_MAX),
          whenToUse: clampText(item.whenToUse, 400),
          mtime: 0,
          invocable: true,
        })
      }
    }
  } catch {
    // 内置目录缺席不是错误
  }
  row.count = skills.length
  if (skills.length === 0) row.present = false
  return { row, skills }
}

// ── 扫描缓存 ────────────────────────────────────────────────────────────

let scanCache = { at: 0, data: null }
let scanInflight = null
let scanInflightGen = -1
let scanGeneration = 0

async function buildScan() {
  const started = Date.now()
  const libs = await discoverLibraries()
  const libraries = []
  const skills = []
  for (const lib of libs) {
    const result = await scanLibrary(lib)
    libraries.push(result.row)
    for (const skill of result.skills) skills.push(skill)
  }
  const builtin = await scanBuiltinSkills()
  if (builtin.skills.length > 0) {
    libraries.push(builtin.row)
    for (const skill of builtin.skills) skills.push(skill)
  }
  return { libraries, skills, scannedAt: Date.now(), durationMs: Date.now() - started }
}

function getScan(force) {
  const now = Date.now()
  if (!force && scanCache.data && now - scanCache.at < SCAN_TTL_MS) return Promise.resolve(scanCache.data)
  if (scanInflight && scanInflightGen === scanGeneration) return scanInflight
  const gen = scanGeneration
  const run = buildScan()
    .then((data) => {
      if (gen === scanGeneration) scanCache = { at: Date.now(), data }
      return data
    })
    .finally(() => {
      if (scanInflight === run) scanInflight = null
    })
  scanInflight = run
  scanInflightGen = gen
  return run
}

function invalidateScan() {
  scanGeneration += 1
  scanCache = { at: 0, data: null }
  libCache = { at: 0, libs: [] }
}

// ── 分类 ────────────────────────────────────────────────────────────────

/** 中文关键词按子串匹配；英文关键词按词边界匹配，避免 'ci' 命中 official 这类误判。 */
function keywordHit(haystack, keyword) {
  const needle = String(keyword || '').toLowerCase().trim()
  if (needle === '') return false
  if (/[\u3400-\u9fff]/.test(needle)) return haystack.includes(needle)
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`).test(haystack)
  } catch {
    return haystack.includes(needle)
  }
}

function autoCategoryId(skill) {
  const haystack = `${skill.name} ${skill.description} ${skill.whenToUse || ''}`.toLowerCase()
  if (haystack.trim() === '') return 'default'
  const ordered = state.categories.slice().sort((a, b) => a.order - b.order)
  for (const category of ordered) {
    if (category.id === 'default') continue
    const keywords = Array.isArray(category.keywords) ? category.keywords : []
    for (const keyword of keywords) {
      if (keywordHit(haystack, keyword)) return category.id
    }
  }
  return 'default'
}

/** 主题识别：只看主题字典，用来统计本机实际有哪些主题。 */
function detectTopic(skill) {
  const haystack = `${skill.name} ${skill.description} ${skill.whenToUse || ''}`.toLowerCase()
  if (haystack.trim() === '') return null
  for (const topic of TOPIC_DEFS) {
    for (const keyword of topic.keywords) {
      if (keywordHit(haystack, keyword)) return topic
    }
  }
  return null
}

/**
 * 自动整理：读取本机实际技能，把命中数达到阈值的主题建成分类。
 * 只重建 auto 分类与它们的关键词；用户自建分类、手动归类、中文名都不动。
 */
async function organizeCategories(existingScan) {
  const scan = existingScan || (await getScan(false))
  const counts = new Map()
  for (const skill of scan.skills) {
    const topic = detectTopic(skill)
    if (!topic) continue
    counts.set(topic.id, (counts.get(topic.id) || 0) + 1)
  }
  const removedIds = new Set()
  state.categories = state.categories.filter((category) => {
    if (!category || category.auto !== true) return true
    removedIds.add(category.id)
    return false
  })
  for (const skillKey of Object.keys(state.assignments)) {
    if (removedIds.has(state.assignments[skillKey])) delete state.assignments[skillKey]
  }
  const baseOrder = state.categories.reduce((max, category) => Math.max(max, Number(category.order) || 0), 0)
  const created = []
  // 分类顺序与主题字典顺序一致：识别和归类用同一套优先级，数量与归属才不会错位
  TOPIC_DEFS.forEach((def, index) => {
    const count = counts.get(def.id) || 0
    if (count < MIN_TOPIC_SKILLS) return
    state.categories.push({
      id: `auto-${def.id}`,
      name: def.name,
      builtin: false,
      auto: true,
      order: baseOrder + index + 1,
      keywords: def.keywords.slice(),
    })
    created.push({ id: `auto-${def.id}`, name: def.name, count })
  })
  state.autoOrganizedAt = Date.now()
  scheduleSave()
  invalidateScan()
  return { created, removed: removedIds.size, totalSkills: scan.skills.length }
}

function enrichedSkills(scan) {
  const catIds = new Set(state.categories.map((c) => c.id))
  const usingAuto = state.settings.autoClassify !== false
  return scan.skills.map((skill) => {
    const manual = Object.prototype.hasOwnProperty.call(state.assignments, skill.key) ? state.assignments[skill.key] : null
    let category = manual && catIds.has(manual) ? manual : null
    if (!category) category = usingAuto ? autoCategoryId(skill) : 'default'
    if (!catIds.has(category)) category = 'default'
    const override = state.overrides[skill.key] || null
    const cached = state.translations[sha1(`${skill.description}\nzh-CN`)] || null
    const categoryRow = state.categories.find((c) => c.id === category)
    let descriptionZh = (override && typeof override.descriptionZh === 'string' ? override.descriptionZh : '') || (cached && cached.zh) || ''
    let scene = (override && typeof override.scene === 'string' ? override.scene : '') || ''
    // 已经是中文的技能直接把原文当中文简介，避免出现「待翻译」标记
    if (descriptionZh === '' && skill.description !== '' && !needsTranslation(skill.description)) {
      descriptionZh = skill.description
    }
    if (scene === '' && cached) scene = sceneFromChinese(cached.zh, category, categoryRow && categoryRow.name)
    if (scene === '') scene = sceneFromChinese(descriptionZh, category, categoryRow && categoryRow.name)
    const alias = state.aliases[skill.name]
    return {
      ...skill,
      displayName: typeof alias === 'string' ? alias : '',
      descriptionZh,
      scene,
      translated: descriptionZh !== '',
      category,
      categoryManual: manual !== null && manual !== undefined,
    }
  })
}

/** 仓库列表里的技能也带上用户起的中文名（安装前可编辑）。 */
function reposWithAliases() {
  return state.repos.map((repo) => ({
    ...repo,
    skills: (Array.isArray(repo.skills) ? repo.skills : []).map((skill) => {
      const alias = state.repoAliases[`${repo.id}::${skill.path}`]
      return { ...skill, displayName: typeof alias === 'string' ? alias : '' }
    }),
  }))
}

function categoriesWithCounts(skills) {
  const counts = new Map()
  for (const skill of skills) counts.set(skill.category, (counts.get(skill.category) || 0) + 1)
  return state.categories
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((category) => ({ ...category, count: counts.get(category.id) || 0 }))
}

// ── 翻译 ────────────────────────────────────────────────────────────────

let translateAvailability = { at: 0, available: false }

async function translatorAvailable() {
  const preference = state.settings.translateProvider || 'auto'
  if (preference === 'off') return false
  if (Date.now() - translateAvailability.at < 60_000) return translateAvailability.available
  let available = false
  try {
    const svc = ctxRef.get('translator')
    if (svc && typeof svc.availableProviders === 'function') {
      const providers = await svc.availableProviders()
      available = Array.isArray(providers) && providers.length > 0
    }
  } catch {
    available = false
  }
  // 宿主翻译服务缺席时，直连匿名翻译通道仍可用（失败由 /translate 报错）
  if (!available) available = true
  translateAvailability = { at: Date.now(), available }
  return available
}

function decodeEntities(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

async function fetchTimed(url, ms, as) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-skill-manager/1.0' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return as === 'json' ? await response.json() : await response.text()
  } finally {
    clearTimeout(timer)
  }
}

/** 把长文本切成匿名翻译接口能接受的块（按句/词边界）。 */
function splitForTranslate(text, max) {
  const value = String(text || '').trim()
  if (value.length <= max) return [value]
  const chunks = []
  let rest = value
  while (rest.length > max) {
    let cut = rest.lastIndexOf('. ', max)
    if (cut < max * 0.4) cut = rest.lastIndexOf('; ', max)
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max)
    if (cut < max * 0.4) cut = max
    chunks.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

const providerCooldown = { google: 0, mymemory: 0 }

async function httpTranslateChunk(text) {
  const now = Date.now()
  if (now > providerCooldown.google) {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`
      const data = await fetchTimed(url, 2500, 'json')
      const segments = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : []
      const out = segments.map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : '')).join('')
      if (out.trim() !== '') return { text: out.trim(), provider: 'google' }
    } catch {
      providerCooldown.google = Date.now() + 10 * 60_000
    }
  }
  if (now > providerCooldown.mymemory) {
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-CN`
      const data = await fetchTimed(url, 9000, 'json')
      const out = data && data.responseData && data.responseData.translatedText
      if (typeof out === 'string' && out.trim() !== '' && !/MYMEMORY WARNING/i.test(out)) {
        const status = data && data.responseStatus
        if (typeof status === 'number' && status >= 400) throw new Error(`provider status ${status}`)
        return { text: decodeEntities(out).trim(), provider: 'mymemory' }
      }
    } catch {
      providerCooldown.mymemory = Date.now() + 5 * 60_000
    }
  }
  throw httpError(502, '翻译服务暂不可用（匿名通道被占用或网络不可达）', 'TRANSLATE_UNAVAILABLE')
}

async function httpTranslate(text) {
  const chunks = splitForTranslate(clampText(text, TRANSLATE_TEXT_MAX), 420)
  const parts = []
  let provider = null
  for (const chunk of chunks) {
    const result = await httpTranslateChunk(chunk)
    parts.push(result.text)
    provider = result.provider
  }
  return { text: parts.join(''), provider }
}

function validProviderName(name) {
  return name === 'google' || name === 'bing'
}

async function translateOnce(text) {
  const preference = state.settings.translateProvider || 'auto'
  if (preference === 'off') throw httpError(503, '翻译已关闭', 'TRANSLATE_UNAVAILABLE')
  const trimmed = clampText(text, TRANSLATE_TEXT_MAX)
  // 1) 宿主 translator 服务（有 provider 时优先，质量更稳）
  const svc = ctxRef.get('translator')
  if (svc) {
    let providers = []
    try {
      const list = await svc.availableProviders()
      providers = Array.isArray(list) ? list.filter((item) => validProviderName(item)) : []
    } catch {
      providers = []
    }
    if (providers.length > 0) {
      const chain = preference === 'auto' ? providers : providers.filter((item) => item === preference)
      for (const provider of chain.length > 0 ? chain : providers) {
        for (const lang of ['zh-CN', 'zh']) {
          try {
            const spec = svc.resolve({ text: trimmed, targetLanguage: lang, provider })
            const out = await svc.translate(spec)
            if (typeof out === 'string' && out.trim() !== '') return { text: out.trim(), provider }
          } catch {
            // 继续尝试下一个 provider / 直连
          }
        }
      }
    }
  }
  // 2) 直连匿名通道
  return httpTranslate(trimmed)
}

function defaultSceneFor(categoryId, categoryName) {
  if (categoryId === 'default') return '通用场景：需要该技能的专项能力时使用。'
  const label = String(categoryName || '相关').replace(/助手$/, '')
  return `需要${label}相关任务时使用。`
}

function extractSceneSource(description) {
  const match = /(?:use (?:this skill )?when|when to use|use when)[:：]?\s*([^.]{5,200})/i.exec(String(description || ''))
  if (match) return match[1].trim()
  return ''
}

/** 从中文简介里提取「适用场景」：优先取“当…时/适用于/用于”从句，避免与简介首句重复。 */
function sceneFromChinese(zh, categoryId, categoryName) {
  const text = String(zh || '').trim()
  if (text !== '') {
    const patterns = [/(当[^。！？；]{4,80}?时)/, /(适用于[^。！？；]{4,80})/, /(用于[^。！？；]{4,80})/]
    for (const pattern of patterns) {
      const match = pattern.exec(text)
      if (match && match[1]) {
        const clause = match[1].trim()
        if (clause.length >= 4) return clause.length > 72 ? `${clause.slice(0, 72)}…` : `${clause}。`
      }
    }
  }
  return defaultSceneFor(categoryId, categoryName)
}

async function translateSkill(skill) {
  const category = state.categories.find((c) => c.id === skill.category)
  const categoryName = category && category.name
  if (!needsTranslation(skill.description) && !needsTranslation(skill.whenToUse)) {
    return {
      descriptionZh: skill.description,
      scene: sceneFromChinese(skill.description, skill.category, categoryName),
      provider: null,
      skipped: true,
    }
  }
  const descKey = sha1(`${skill.description}\nzh-CN`)
  const cached = state.translations[descKey]
  if (cached && typeof cached.zh === 'string' && cached.zh !== '') {
    return {
      descriptionZh: cached.zh,
      scene: sceneFromChinese(cached.zh, skill.category, categoryName),
      provider: cached.provider || null,
      cached: true,
    }
  }
  let provider = null
  let zh = ''
  if (needsTranslation(skill.description)) {
    const result = await translateOnce(skill.description)
    zh = result.text
    provider = result.provider
  }
  // 适用场景始终从中文简介里的“当…时/适用于/用于”从句提取；没有就用分类模板，
  // 避免与简介首句重复，也避免再为 whenToUse 多消耗一次翻译额度。
  const scene = sceneFromChinese(zh, skill.category, categoryName)
  if (zh !== '') {
    state.translations[descKey] = { zh, scene, at: Date.now(), provider }
    scheduleSave()
  }
  return { descriptionZh: zh, scene, provider, cached: false }
}

// ── 文件操作：体积、复制、回收站 ─────────────────────────────────────────

async function walkDir(root, limits) {
  const maxFiles = limits && limits.maxFiles ? limits.maxFiles : COPY_FILE_MAX
  const maxBytes = limits && limits.maxBytes ? limits.maxBytes : COPY_BYTES_MAX
  const files = []
  let bytes = 0
  async function visit(dir, rel, depth) {
    if (depth > 12) return
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const abs = join(dir, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      let stat
      try {
        stat = await fsp.lstat(abs)
        if (stat.isSymbolicLink()) stat = await fsp.stat(abs)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        await visit(abs, childRel, depth + 1)
      } else if (stat.isFile()) {
        bytes += stat.size
        files.push({ abs, rel: childRel, size: stat.size })
        if (files.length > maxFiles) throw httpError(413, '技能文件过多，已拒绝操作', 'TOO_LARGE')
        if (bytes > maxBytes) throw httpError(413, '技能体积过大，已拒绝操作', 'TOO_LARGE')
      }
    }
  }
  await visit(root, '', 0)
  return { files, bytes }
}

async function copyTree(from, to) {
  const { files } = await walkDir(from)
  for (const file of files) {
    const target = join(to, ...file.rel.split('/'))
    await fsp.mkdir(dirname(target), { recursive: true })
    await fsp.copyFile(file.abs, target)
  }
}

/** 同一目标目录的写操作串行化，避免并发复制/安装交错写坏目录。 */
const pathLocks = new Map()

async function withPathLock(targetDir, worker) {
  const key = normPathKey(targetDir)
  const previous = pathLocks.get(key)
  if (previous) await previous.catch(() => {})
  let release
  const gate = new Promise((resolveGate) => {
    release = resolveGate
  })
  pathLocks.set(key, gate)
  try {
    return await worker()
  } finally {
    if (pathLocks.get(key) === gate) pathLocks.delete(key)
    release()
  }
}

async function resolveConflict(targetDir, onConflict, meta) {
  const exists = await statDir(targetDir)
  if (!exists) return { dir: targetDir, action: 'none' }
  const mode = onConflict === 'overwrite' || onConflict === 'rename' ? onConflict : 'skip'
  if (mode === 'skip') return { dir: targetDir, action: 'skip' }
  if (mode === 'overwrite') {
    const id = trashId()
    const slot = join(TRASH_DIR, id)
    await fsp.mkdir(slot, { recursive: true })
    const info = await walkDir(targetDir).catch(() => ({ files: [], bytes: 0 }))
    await renameWithFallback(targetDir, join(slot, 'files'))
    const manifest = {
      id,
      lib: (meta && meta.lib) || '',
      libLabel: (meta && meta.libLabel) || '',
      name: (meta && meta.name) || basename(targetDir),
      relPath: (meta && meta.name) || basename(targetDir),
      originalPath: targetDir,
      at: Date.now(),
      bytes: info.bytes || 0,
      reason: 'overwrite',
    }
    await fsp.writeFile(join(slot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8').catch(() => {})
    return { dir: targetDir, action: 'overwrite', trashed: id }
  }
  let index = 2
  let candidate = `${targetDir}-${index}`
  while (await statDir(candidate)) {
    index += 1
    candidate = `${targetDir}-${index}`
    if (index > 50) throw httpError(409, '同名技能过多，无法重命名', 'CONFLICT')
  }
  return { dir: candidate, action: 'rename', renamed: basename(candidate) }
}

async function moveToTrash(lib, skill) {
  const id = trashId()
  const slot = join(TRASH_DIR, id)
  await fsp.mkdir(slot, { recursive: true })
  let bytes = 0
  try {
    const info = await walkDir(skill.dir)
    bytes = info.bytes
  } catch {
    bytes = 0
  }
  await renameWithFallback(skill.dir, join(slot, 'files'))
  const manifest = {
    id,
    lib: lib.key,
    libLabel: lib.label,
    name: skill.name,
    relPath: skill.relPath,
    originalPath: skill.dir,
    at: Date.now(),
    bytes,
  }
  await fsp.writeFile(join(slot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return manifest
}

async function listTrash() {
  let entries = []
  try {
    entries = await fsp.readdir(TRASH_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !validTrashId(entry.name)) continue
    const manifest = await readJsonFile(join(TRASH_DIR, entry.name, 'manifest.json'))
    if (!manifest) continue
    out.push({
      id: manifest.id || entry.name,
      lib: manifest.lib || '',
      libLabel: manifest.libLabel || '',
      name: manifest.name || '',
      relPath: manifest.relPath || '',
      originalPath: manifest.originalPath || '',
      at: manifest.at || 0,
      bytes: manifest.bytes || 0,
    })
  }
  out.sort((a, b) => b.at - a.at)
  return out
}

// ── 仓库识别与安装 ──────────────────────────────────────────────────────

function parseRepoUrl(input) {
  const raw = String(input || '').trim()
  if (raw === '') throw httpError(400, '请填写仓库地址', 'UNSUPPORTED_URL')
  let text = raw.replace(/^git\+/, '')
  const ssh = /^git@([^:]+):(.+)$/i.exec(text)
  if (ssh) text = `https://${ssh[1]}/${ssh[2]}`
  if (!/^https?:\/\//i.test(text)) {
    if (/^[\w.-]+\/[\w.-]+(?:\/.*)?$/.test(text)) text = `https://github.com/${text}`
    else throw httpError(400, '无法识别的仓库地址', 'UNSUPPORTED_URL')
  }
  let url
  try {
    url = new URL(text)
  } catch {
    throw httpError(400, '无法识别的仓库地址', 'UNSUPPORTED_URL')
  }
  const host = url.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw httpError(400, '目前只支持 GitHub 仓库地址', 'UNSUPPORTED_URL')
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2) throw httpError(400, '地址里缺少仓库名', 'UNSUPPORTED_URL')
  const owner = segments[0]
  let repo = segments[1].replace(/\.git$/i, '')
  let subdir = ''
  let ref = ''
  if (segments.length >= 4 && (segments[2] === 'tree' || segments[2] === 'blob')) {
    ref = segments[3]
    subdir = segments.slice(4).join('/')
  } else if (segments.length > 2) {
    subdir = segments.slice(2).join('/')
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw httpError(400, '仓库名不合法', 'UNSUPPORTED_URL')
  }
  return { owner, repo, ref: ref || '', subdir, url: `https://github.com/${owner}/${repo}` }
}

async function httpJson(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs || NET_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'dsh-skill-manager/1.0',
        accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    })
    if (response.status === 404) throw httpError(404, '仓库不存在或没有访问权限（私有仓库暂不支持）', 'NOT_FOUND')
    if (response.status === 403 || response.status === 429) {
      throw httpError(429, 'GitHub 接口访问受限，请稍后再试', 'RATE_LIMITED')
    }
    if (!response.ok) throw httpError(502, `GitHub 接口返回 ${response.status}`, 'RECOGNIZE_FAILED')
    return await response.json()
  } catch (err) {
    if (err && err.name === 'AbortError') throw httpError(504, '请求超时，请检查网络后重试', 'NETWORK')
    if (err && err.status) throw err
    throw httpError(502, `网络请求失败：${err && err.message ? err.message : err}`, 'NETWORK')
  } finally {
    clearTimeout(timer)
  }
}

async function httpFetch(url, as) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'dsh-skill-manager/1.0' }, signal: controller.signal })
    if (response.status === 403 || response.status === 429) {
      throw httpError(429, 'GitHub 访问受限，请稍后再试', 'RATE_LIMITED')
    }
    if (!response.ok) throw httpError(502, `下载失败（HTTP ${response.status}）`, 'NETWORK')
    return as === 'buffer' ? Buffer.from(await response.arrayBuffer()) : await response.text()
  } catch (err) {
    if (err && err.name === 'AbortError') throw httpError(504, '下载超时，请检查网络后重试', 'NETWORK')
    if (err && err.status) throw err
    throw httpError(502, `下载失败：${err && err.message ? err.message : err}`, 'NETWORK')
  } finally {
    clearTimeout(timer)
  }
}

/** 读取远程文本；失败返回空串（用于可选元数据，如仓库内 SKILL.md 的 frontmatter）。 */
async function httpTextQuiet(url) {
  try {
    return await httpFetch(url, 'text')
  } catch {
    return ''
  }
}

function rawUrl(owner, repo, ref, path) {
  const encoded = String(path).split('/').map((part) => encodeURIComponent(part)).join('/')
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${encoded}`
}

const treeCache = new Map()

async function fetchTree(owner, repo, ref, force) {
  const key = `${owner}/${repo}@${ref}`
  const cached = treeCache.get(key)
  if (!force && cached && Date.now() - cached.at < 5 * 60_000) return cached.tree
  const payload = await httpJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
  const tree = Array.isArray(payload && payload.tree) ? payload.tree : []
  treeCache.set(key, { at: Date.now(), tree })
  return tree
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let index = 0
  const runners = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await worker(items[current], current)
    }
  })
  await Promise.all(runners)
  return results
}

async function recognizeRepo(input, options) {
  const force = !!(options && options.force)
  const parsed = parseRepoUrl(input)
  const meta = await httpJson(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`)
  const ref = parsed.ref || (meta && meta.default_branch) || 'main'
  const tree = await fetchTree(parsed.owner, parsed.repo, ref, force)
  const blobs = tree.filter((entry) => entry && entry.type === 'blob' && typeof entry.path === 'string')
  const skillFiles = blobs.filter((entry) => entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md'))
  const dirs = []
  const seen = new Set()
  for (const entry of skillFiles) {
    const dir = entry.path === 'SKILL.md' ? '' : entry.path.slice(0, -'/SKILL.md'.length)
    if (parsed.subdir !== '') {
      const prefix = parsed.subdir.replace(/\/+$/, '')
      if (dir !== prefix && !dir.startsWith(`${prefix}/`)) continue
    }
    if (seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  if (dirs.length === 0) {
    throw httpError(404, parsed.subdir !== '' ? '该目录下没有找到 SKILL.md' : '这个仓库里没有找到任何 SKILL.md', 'RECOGNIZE_FAILED')
  }
  const limited = dirs.slice(0, REPO_SKILL_MAX)
  const skills = limited.map((dir) => {
    const prefix = dir === '' ? '' : `${dir}/`
    let files = 0
    let bytes = 0
    for (const entry of blobs) {
      if (prefix !== '' && !entry.path.startsWith(prefix)) continue
      if (prefix === '' && entry.path.includes('/')) continue
      files += 1
      bytes += entry.size || 0
    }
    return {
      path: dir === '' ? '.' : dir,
      name: dir === '' ? parsed.repo : basename(dir),
      description: '',
      files,
      bytes,
    }
  })
  const metaTargets = skills.slice(0, REPO_META_FETCH_MAX)
  await mapLimit(metaTargets, 8, async (row) => {
    const filePath = row.path === '.' ? 'SKILL.md' : `${row.path}/SKILL.md`
    const text = await httpTextQuiet(rawUrl(parsed.owner, parsed.repo, ref, filePath))
    if (text === '') return
    const fm = parseFrontmatter(text)
    if (typeof fm.name === 'string' && fm.name.trim() !== '') row.name = fm.name.trim().replace(/^["']|["']$/g, '')
    row.description = clampText(fm.description, DESCRIPTION_MAX)
  })
  const repo = {
    id: `gh:${parsed.owner}/${parsed.repo}`,
    url: parsed.url,
    owner: parsed.owner,
    repo: parsed.repo,
    ref,
    stars: meta && typeof meta.stargazers_count === 'number' ? meta.stargazers_count : 0,
    subdir: parsed.subdir,
    savedAt: 0,
    recognizedAt: Date.now(),
    error: null,
    truncated: dirs.length > limited.length,
    skills,
  }
  return repo
}

async function installRepoSkill(repo, skillPath, lib, onConflict, displayName) {
  if (!repo || typeof repo !== 'object') throw httpError(404, '仓库不存在', 'NOT_FOUND')
  if (!lib || lib.writable !== true) throw httpError(403, '目标技能库不可写', 'READ_ONLY')
  const tree = await fetchTree(repo.owner, repo.repo, repo.ref)
  const blobs = tree.filter((entry) => entry && entry.type === 'blob' && typeof entry.path === 'string')
  const dir = skillPath === '.' || skillPath === '' ? '' : String(skillPath).replace(/\/+$/, '')
  const prefix = dir === '' ? '' : `${dir}/`
  const files = blobs.filter((entry) => {
    if (prefix === '' && entry.path.includes('/')) return false
    if (prefix !== '' && !entry.path.startsWith(prefix)) return false
    return true
  })
  if (files.length === 0) throw httpError(404, '该技能下没有可安装的文件', 'NOT_FOUND')
  if (files.length > INSTALL_FILE_MAX) throw httpError(413, '技能文件过多，已拒绝安装', 'TOO_LARGE')
  let total = 0
  for (const entry of files) {
    if ((entry.size || 0) > INSTALL_FILE_BYTES_MAX) throw httpError(413, '存在超大文件，已拒绝安装', 'TOO_LARGE')
    total += entry.size || 0
  }
  if (total > INSTALL_TOTAL_BYTES_MAX) throw httpError(413, '技能体积过大，已拒绝安装', 'TOO_LARGE')

  const known = (repo.skills || []).find((row) => row.path === (dir === '' ? '.' : dir))
  const baseName = safeSkillDirName(known && known.name ? known.name : dir === '' ? repo.repo : basename(dir))
  if (baseName === '') throw httpError(400, '技能名不合法', 'INVALID_NAME')
  const wanted = join(lib.dir, baseName)
  return withPathLock(wanted, async () => {
    const conflict = await resolveConflict(wanted, onConflict, { lib: lib.key, libLabel: lib.label, name: baseName })
    if (conflict.action === 'skip') {
      return { ok: true, skipped: true, action: 'skipped', targetPath: conflict.dir, files: 0, bytes: 0, renamed: null }
    }
    await fsp.mkdir(conflict.dir, { recursive: true })
    let written = 0
    let bytes = 0
    try {
      await mapLimit(files, 6, async (entry) => {
        const rel = prefix === '' ? entry.path : entry.path.slice(prefix.length)
        const target = join(conflict.dir, ...rel.split('/'))
        const buffer = await httpFetch(rawUrl(repo.owner, repo.repo, repo.ref, entry.path), 'buffer')
        await fsp.mkdir(dirname(target), { recursive: true })
        await fsp.writeFile(target, buffer)
        written += 1
        bytes += buffer.length
      })
    } catch (err) {
      await fsp.rm(conflict.dir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
    const skillMd = join(conflict.dir, 'SKILL.md')
    const exists = await fsp.stat(skillMd).then(() => true).catch(() => false)
    if (!exists) {
      await fsp.rm(conflict.dir, { recursive: true, force: true }).catch(() => {})
      throw httpError(502, '安装结果缺少 SKILL.md，已回滚', 'RECOGNIZE_FAILED')
    }
    state.installs[`${repo.id}::${dir === '' ? '.' : dir}`] = {
      lib: lib.key,
      path: conflict.dir,
      ref: repo.ref,
      at: Date.now(),
    }
    // 中文名：优先用本次传入的名称，其次用仓库列表里保存的名称；写入按 frontmatter name 索引的别名表
    const installedMeta = await readFrontmatter(conflict.dir)
    const installedName = installedMeta && typeof installedMeta.meta.name === 'string' && installedMeta.meta.name.trim() !== ''
      ? installedMeta.meta.name.trim().replace(/^["']|["']$/g, '')
      : baseName
    const nameFromRepo = state.repoAliases[`${repo.id}::${dir === '' ? '.' : dir}`]
    const wantedName = typeof displayName === 'string' && displayName.trim() !== ''
      ? clampText(displayName, 60)
      : (typeof nameFromRepo === 'string' && nameFromRepo.trim() !== '' ? clampText(nameFromRepo, 60) : '')
    if (wantedName !== '') state.aliases[installedName] = wantedName
    scheduleSave()
    invalidateScan()
    return {
      ok: true,
      action: 'installed',
      targetPath: conflict.dir,
      files: written,
      bytes,
      displayName: wantedName,
      skillName: installedName,
      renamed: conflict.action === 'rename' ? basename(conflict.dir) : null,
    }
  })
}

// ── 状态组装 ────────────────────────────────────────────────────────────

function libraryRows(scan) {
  return scan.libraries.map((row) => ({
    key: row.key,
    label: row.label,
    dir: row.dir,
    displayDir: row.displayDir,
    writable: row.writable,
    copyable: row.copyable,
    present: row.present,
    count: row.count,
    error: row.error,
    auto: row.auto,
  }))
}

/** 安装记录对应目录被删/移走后自动清理，避免仓库列表一直显示「已安装」。 */
async function pruneInstalls() {
  let changed = false
  for (const recordKey of Object.keys(state.installs)) {
    const record = state.installs[recordKey]
    if (!record || typeof record.path !== 'string') {
      delete state.installs[recordKey]
      changed = true
      continue
    }
    const exists = await fsp.stat(record.path).then(() => true).catch(() => false)
    if (!exists) {
      delete state.installs[recordKey]
      changed = true
    }
  }
  if (changed) scheduleSave()
  return state.installs
}

async function buildState(force) {
  let scan = await getScan(force)
  // 首次运行（或刚升级到自动分类）时，按本机实际技能生成分类
  if (!state.autoOrganizedAt) {
    await organizeCategories(scan)
    scan = await getScan(true)
  }
  const skills = enrichedSkills(scan)
  const categories = categoriesWithCounts(skills)
  const available = await translatorAvailable()
  const installs = await pruneInstalls()
  return {
    scannedAt: scan.scannedAt,
    durationMs: scan.durationMs,
    translateAvailable: available,
    libraries: libraryRows(scan),
    skills,
    categories,
    repos: reposWithAliases(),
    installs,
    aliases: state.aliases,
    repoAliases: state.repoAliases,
    settings: state.settings,
    trash: await listTrash(),
  }
}

// ── HTTP 路由 ───────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try {
      res.writeHead(500)
      res.end()
    } catch {
      // ignore
    }
  }
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    let settled = false
    const chunks = []
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        settled = true
        chunks.length = 0
        rejectBody(httpError(413, '请求体过大', 'TOO_LARGE'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      if (chunks.length === 0) {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        rejectBody(httpError(400, '请求体不是合法 JSON', 'BAD_PATH'))
      }
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      rejectBody(err)
    })
  })
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw httpError(400, `${label}不能为空`, 'INVALID_NAME')
  return value.trim()
}

async function lookupSkill(key) {
  const scan = await getScan(false)
  const skill = scan.skills.find((item) => item.key === key)
  if (!skill) throw httpError(404, '技能不存在，请刷新后重试', 'NOT_FOUND')
  return skill
}

async function requireLibrary(key) {
  await discoverLibraries()
  const lib = findLibrary(key)
  if (!lib) throw httpError(404, '技能库不存在', 'NOT_FOUND')
  return lib
}

async function safeDetail(skill) {
  const file = join(skill.dir, 'SKILL.md')
  let raw = ''
  let truncated = false
  let handle
  try {
    handle = await fsp.open(file, 'r')
    const stat = await handle.stat()
    const take = Math.min(stat.size, DETAIL_MAX_BYTES)
    const buffer = Buffer.alloc(take)
    const { bytesRead } = await handle.read(buffer, 0, take, 0)
    raw = buffer.subarray(0, bytesRead).toString('utf8')
    truncated = stat.size > DETAIL_MAX_BYTES
  } catch (err) {
    throw httpError(404, `无法读取 SKILL.md：${err && err.message ? err.message : err}`, 'NOT_FOUND')
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // ignore
      }
    }
  }
  let files = []
  let bytes = 0
  try {
    const info = await walkDir(skill.dir, { maxFiles: 400, maxBytes: 1024 * 1024 * 1024 })
    bytes = info.bytes
    files = info.files.map((item) => ({ path: item.rel, size: item.size }))
  } catch {
    files = []
  }
  let mtime = 0
  try {
    const stat = await fsp.stat(file)
    mtime = stat.mtimeMs
  } catch {
    mtime = skill.mtime
  }
  return {
    key: skill.key,
    content: raw,
    frontmatter: parseFrontmatter(raw),
    files,
    bytes,
    mtime,
    truncated,
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', 'http://dsh.local')
  const pathname = url.pathname.replace(/\/+$/, '')
  const route = pathname.slice(API_PREFIX.length) || '/'
  const method = (req.method || 'GET').toUpperCase()
  const key = `${method} ${route}`

  if (key === 'GET /state') {
    const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true'
    sendJson(res, 200, await buildState(force))
    return
  }

  if (key === 'GET /skill') {
    const libKey = (url.searchParams.get('lib') || '').trim()
    const relPath = (url.searchParams.get('path') || '').trim()
    if (libKey === '' || relPath === '') throw httpError(400, '缺少技能库或技能路径', 'BAD_PATH')
    const skill = await lookupSkill(`${libKey}::${relPath.split('\\').join('/')}`)
    sendJson(res, 200, await safeDetail(skill))
    return
  }

  if (key === 'GET /trash') {
    sendJson(res, 200, { items: await listTrash() })
    return
  }

  const body = method === 'GET' ? {} : await readBody(req)

  // 手动触发「自动整理」：按当前本机技能重建自动分类
  if (key === 'POST /organize') {
    const result = await organizeCategories()
    const next = await buildState(true)
    sendJson(res, 200, {
      ok: true,
      created: result.created,
      removed: result.removed,
      categories: next.categories,
      skills: next.skills.map((skill) => ({ key: skill.key, category: skill.category, categoryManual: skill.categoryManual })),
    })
    return
  }

  if (key === 'POST /categories') {
    const name = requireString(body.name, '分类名称')
    if (state.categories.some((c) => c.name === name)) throw httpError(409, '分类名称已存在', 'CONFLICT')
    const id = `c-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
    const order = state.categories.reduce((max, c) => Math.max(max, c.order), 0) + 1
    state.categories.push({ id, name, builtin: false, order, keywords: [] })
    scheduleSave()
    sendJson(res, 200, { categories: await currentCategories() })
    return
  }

  if (key === 'PATCH /categories') {
    const id = requireString(body.id, '分类 id')
    const category = state.categories.find((c) => c.id === id)
    if (!category) throw httpError(404, '分类不存在', 'NOT_FOUND')
    if (typeof body.name === 'string') {
      if (category.id === 'default') throw httpError(400, '默认分类不能重命名', 'READ_ONLY')
      const name = requireString(body.name, '分类名称')
      if (state.categories.some((c) => c.id !== id && c.name === name)) throw httpError(409, '分类名称已存在', 'CONFLICT')
      category.name = name
    }
    if (Array.isArray(body.keywords)) {
      category.keywords = body.keywords.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()).slice(0, 60)
    }
    if (typeof body.order === 'number' && Number.isFinite(body.order)) category.order = body.order
    state.categories.sort((a, b) => a.order - b.order)
    scheduleSave()
    invalidateScan()
    sendJson(res, 200, { categories: await currentCategories() })
    return
  }

  if (key === 'DELETE /categories') {
    const id = requireString(body.id, '分类 id')
    if (id === 'default') throw httpError(400, '默认分类不能删除', 'READ_ONLY')
    const category = state.categories.find((c) => c.id === id)
    if (!category) throw httpError(404, '分类不存在', 'NOT_FOUND')
    // 先算出该分类下的技能（含自动归类），删除后统一钉到默认分类
    let affected = []
    try {
      const scan = await getScan(false)
      affected = enrichedSkills(scan).filter((skill) => skill.category === id).map((skill) => skill.key)
    } catch {
      affected = []
    }
    state.categories = state.categories.filter((c) => c.id !== id)
    for (const skillKey of affected) state.assignments[skillKey] = 'default'
    for (const skillKey of Object.keys(state.assignments)) {
      if (state.assignments[skillKey] === id) state.assignments[skillKey] = 'default'
    }
    scheduleSave()
    sendJson(res, 200, { categories: await currentCategories(), moved: affected.length })
    return
  }

  if (key === 'PATCH /assign') {
    const skillKey = requireString(body.key, '技能')
    await lookupSkill(skillKey)
    const categoryId = body.categoryId === null || body.categoryId === undefined ? null : String(body.categoryId)
    if (categoryId === null) delete state.assignments[skillKey]
    else {
      if (!state.categories.some((c) => c.id === categoryId)) throw httpError(404, '分类不存在', 'NOT_FOUND')
      state.assignments[skillKey] = categoryId
    }
    scheduleSave()
    const scan = await getScan(false)
    const enriched = enrichedSkills(scan).filter((skill) => skill.key === skillKey)
    sendJson(res, 200, {
      skills: enriched.map((skill) => ({ key: skill.key, category: skill.category, categoryManual: skill.categoryManual })),
      categories: categoriesWithCounts(enrichedSkills(scan)),
    })
    return
  }

  if (key === 'POST /copy') {
    const skill = await lookupSkill(requireString(body.key, '技能'))
    const targetLib = await requireLibrary(requireString(body.toLib, '目标技能库'))
    if (targetLib.writable !== true) throw httpError(403, '目标技能库不可写', 'READ_ONLY')
    const sourceLib = findLibrary(skill.lib)
    if (!sourceLib || sourceLib.copyable !== true) throw httpError(403, '该来源不支持复制', 'READ_ONLY')
    const info = await walkDir(skill.dir)
    const baseName = safeSkillDirName(basename(skill.dir))
    if (baseName === '') throw httpError(400, '技能目录名不合法', 'INVALID_NAME')
    const wanted = join(targetLib.dir, baseName)
    if (normPathKey(wanted) === normPathKey(skill.dir)) throw httpError(400, '源目录与目标目录相同', 'BAD_PATH')
    const copied = await withPathLock(wanted, async () => {
      const conflict = await resolveConflict(wanted, body.onConflict, {
        lib: targetLib.key,
        libLabel: targetLib.label,
        name: baseName,
      })
      if (conflict.action === 'skip') {
        return { ok: true, action: 'skipped', targetPath: conflict.dir, files: 0, bytes: 0, renamed: null }
      }
      await fsp.mkdir(conflict.dir, { recursive: true })
      try {
        await copyTree(skill.dir, conflict.dir)
      } catch (err) {
        await fsp.rm(conflict.dir, { recursive: true, force: true }).catch(() => {})
        throw err
      }
      return {
        ok: true,
        action: 'copied',
        targetPath: conflict.dir,
        files: info.files.length,
        bytes: info.bytes,
        renamed: conflict.action === 'rename' ? basename(conflict.dir) : null,
      }
    })
    invalidateScan()
    // 源技能若被手动归过类，把归属一并带到副本上（自动归类不复制，避免钉死规则）
    if (Object.prototype.hasOwnProperty.call(state.assignments, skill.key)) {
      const rel = basename(copied.targetPath)
      state.assignments[`${targetLib.key}::${rel}`] = state.assignments[skill.key]
      scheduleSave()
    }
    sendJson(res, 200, copied)
    return
  }

  if (key === 'POST /delete') {
    const skill = await lookupSkill(requireString(body.key, '技能'))
    const lib = findLibrary(skill.lib)
    if (!lib) {
      if (skill.lib === 'dsh-builtin') throw httpError(403, '内置技能为只读，不能删除', 'READ_ONLY')
      throw httpError(404, '技能库不存在，请刷新后重试', 'NOT_FOUND')
    }
    if (lib.writable !== true) throw httpError(403, '该技能库为只读，不能删除', 'READ_ONLY')
    const manifest = await moveToTrash(lib, skill)
    delete state.assignments[skill.key]
    // 同步清掉指向该目录的安装记录（仓库列表里随之回到「安装」按钮）
    for (const recordKey of Object.keys(state.installs)) {
      const record = state.installs[recordKey]
      if (record && typeof record.path === 'string' && normPathKey(record.path) === normPathKey(skill.dir)) {
        delete state.installs[recordKey]
      }
    }
    invalidateScan()
    sendJson(res, 200, { ok: true, trashId: manifest.id, trash: await listTrash() })
    return
  }

  if (key === 'POST /trash/restore') {
    const id = requireString(body.id, '回收站条目')
    if (!validTrashId(id)) throw httpError(400, '回收站条目 id 不合法', 'BAD_PATH')
    const manifest = await readJsonFile(join(TRASH_DIR, id, 'manifest.json'))
    if (!manifest || typeof manifest.originalPath !== 'string') throw httpError(404, '回收站条目不存在', 'NOT_FOUND')
    const parent = dirname(manifest.originalPath)
    await fsp.mkdir(parent, { recursive: true })
    if (await statDir(manifest.originalPath)) throw httpError(409, '原位置已存在同名技能，请先移走它', 'CONFLICT')
    await renameWithFallback(join(TRASH_DIR, id, 'files'), manifest.originalPath)
    await fsp.rm(join(TRASH_DIR, id), { recursive: true, force: true }).catch(() => {})
    invalidateScan()
    sendJson(res, 200, { ok: true, path: manifest.originalPath, trash: await listTrash() })
    return
  }

  if (key === 'POST /trash/purge') {
    const id = requireString(body.id, '回收站条目')
    if (!validTrashId(id)) throw httpError(400, '回收站条目 id 不合法', 'BAD_PATH')
    await fsp.rm(join(TRASH_DIR, id), { recursive: true, force: true })
    sendJson(res, 200, { ok: true, trash: await listTrash() })
    return
  }

  if (key === 'POST /translate') {
    const keys = Array.isArray(body.keys) ? body.keys.filter((item) => typeof item === 'string').slice(0, TRANSLATE_BATCH_MAX) : []
    if (keys.length === 0) throw httpError(400, '没有要翻译的技能', 'INVALID_NAME')
    if (state.settings.translateProvider === 'off') {
      sendJson(res, 200, { results: [], unavailable: true })
      return
    }
    const available = await translatorAvailable()
    if (!available) {
      sendJson(res, 200, { results: [], unavailable: true })
      return
    }
    const scan = await getScan(false)
    const byKey = new Map(enrichedSkills(scan).map((skill) => [skill.key, skill]))
    const results = []
    let unavailable = false
    for (const skillKey of keys) {
      const skill = byKey.get(skillKey)
      if (!skill) {
        results.push({ key: skillKey, descriptionZh: '', scene: '', translated: false, provider: null, error: '技能不存在' })
        continue
      }
      try {
        const result = await translateSkill(skill)
        results.push({
          key: skillKey,
          descriptionZh: result.descriptionZh,
          scene: result.scene,
          translated: result.descriptionZh !== '',
          provider: result.provider,
          skipped: result.skipped === true,
        })
      } catch (err) {
        results.push({
          key: skillKey,
          descriptionZh: '',
          scene: '',
          translated: false,
          provider: null,
          error: err && err.message ? err.message : '翻译失败',
        })
        // 通道不可用时立即中止本批，避免逐个技能重复等超时
        if (err && err.code === 'TRANSLATE_UNAVAILABLE') {
          unavailable = true
          break
        }
      }
    }
    await saveStateNow()
    sendJson(res, 200, { results, unavailable })
    return
  }

  if (key === 'PATCH /override') {
    const skillKey = requireString(body.key, '技能')
    await lookupSkill(skillKey)
    const current = state.overrides[skillKey] || {}
    const next = { ...current }
    if (typeof body.descriptionZh === 'string') next.descriptionZh = clampText(body.descriptionZh, 1200)
    if (typeof body.scene === 'string') next.scene = clampText(body.scene, 600)
    if (next.descriptionZh === '' && next.scene === '') delete state.overrides[skillKey]
    else state.overrides[skillKey] = next
    scheduleSave()
    const scan = await getScan(false)
    const enriched = enrichedSkills(scan).find((skill) => skill.key === skillKey)
    sendJson(res, 200, {
      skills: enriched
        ? [{ key: enriched.key, descriptionZh: enriched.descriptionZh, scene: enriched.scene, translated: enriched.translated }]
        : [],
    })
    return
  }

  if (key === 'POST /repos/recognize') {
    const repo = await recognizeRepo(requireString(body.url, '仓库地址'))
    sendJson(res, 200, { ok: true, repo })
    return
  }

  if (key === 'POST /repos') {
    const repo = await recognizeRepo(requireString(body.url, '仓库地址'))
    const existing = state.repos.find((item) => item.id === repo.id)
    const saved = { ...repo, savedAt: existing && existing.savedAt ? existing.savedAt : Date.now() }
    if (existing) state.repos = state.repos.map((item) => (item.id === repo.id ? saved : item))
    else state.repos = [saved, ...state.repos]
    scheduleSave()
    sendJson(res, 200, { repo: saved, repos: reposWithAliases() })
    return
  }

  if (key === 'DELETE /repos') {
    const id = requireString(body.id, '仓库')
    state.repos = state.repos.filter((item) => item.id !== id)
    for (const installKey of Object.keys(state.installs)) {
      if (installKey.startsWith(`${id}::`)) delete state.installs[installKey]
    }
    scheduleSave()
    sendJson(res, 200, { repos: reposWithAliases() })
    return
  }

  if (key === 'POST /repos/refresh') {
    const id = requireString(body.id, '仓库')
    const existing = state.repos.find((item) => item.id === id)
    if (!existing) throw httpError(404, '仓库不在列表中', 'NOT_FOUND')
    const repo = await recognizeRepo(existing.url, { force: true })
    const saved = { ...repo, savedAt: existing.savedAt || Date.now() }
    state.repos = state.repos.map((item) => (item.id === id ? saved : item))
    scheduleSave()
    sendJson(res, 200, { repo: saved, repos: reposWithAliases() })
    return
  }

  if (key === 'POST /install') {
    const repoId = requireString(body.repoId, '仓库')
    const repo = state.repos.find((item) => item.id === repoId)
    if (!repo) throw httpError(404, '仓库不在列表中，请先保存', 'NOT_FOUND')
    const targetLib = await requireLibrary(typeof body.toLib === 'string' && body.toLib !== '' ? body.toLib : 'dsh')
    const result = await installRepoSkill(
      repo,
      typeof body.skillPath === 'string' ? body.skillPath : '.',
      targetLib,
      body.onConflict,
      typeof body.displayName === 'string' ? body.displayName : undefined,
    )
    sendJson(res, 200, result)
    return
  }

  // 中文显示名：既支持已安装技能（按 frontmatter name），也支持仓库里的待安装技能（repoId + path）
  if (key === 'PATCH /alias') {
    const displayName = typeof body.displayName === 'string' ? clampText(body.displayName, 60) : ''
    const repoId = typeof body.repoId === 'string' ? body.repoId : ''
    if (repoId !== '') {
      const repo = state.repos.find((item) => item.id === repoId)
      if (!repo) throw httpError(404, '仓库不在列表中', 'NOT_FOUND')
      const path = typeof body.path === 'string' && body.path !== '' ? body.path : '.'
      const repoKey = `${repoId}::${path}`
      if (displayName === '') delete state.repoAliases[repoKey]
      else state.repoAliases[repoKey] = displayName
      scheduleSave()
      sendJson(res, 200, { ok: true, repoAliases: state.repoAliases, repos: reposWithAliases() })
      return
    }
    const skillName = requireString(body.name, '技能名')
    if (displayName === '') delete state.aliases[skillName]
    else state.aliases[skillName] = displayName
    scheduleSave()
    const scan = await getScan(false)
    const affected = enrichedSkills(scan).filter((skill) => skill.name === skillName)
    sendJson(res, 200, {
      ok: true,
      aliases: state.aliases,
      skills: affected.map((skill) => ({ key: skill.key, displayName: skill.displayName })),
    })
    return
  }

  if (key === 'PATCH /settings') {
    const settings = state.settings
    if (typeof body.autoTranslate === 'boolean') settings.autoTranslate = body.autoTranslate
    if (typeof body.autoClassify === 'boolean') settings.autoClassify = body.autoClassify
    if (typeof body.translateProvider === 'string' && ['auto', 'google', 'bing', 'off'].includes(body.translateProvider)) {
      settings.translateProvider = body.translateProvider
    }
    if (Array.isArray(body.disabledLibraries)) {
      settings.disabledLibraries = body.disabledLibraries.filter((item) => typeof item === 'string')
    }
    if (Array.isArray(body.customLibraries)) {
      const accepted = []
      for (const item of body.customLibraries) {
        if (!item || typeof item.dir !== 'string' || item.dir.trim() === '') continue
        const expanded = resolve(String(item.dir).trim().replace(/^~(?=$|[\\/])/, HOME))
        if (!isAbsolute(expanded)) continue
        const homeKey = normPathKey(HOME)
        const dirKey = normPathKey(expanded)
        // 只接受 HOME 之下的已存在目录，避免把任意路径变成可写技能库
        if (dirKey === homeKey || !dirKey.startsWith(homeKey + sep.toLowerCase())) {
          throw httpError(400, '自定义技能库必须位于用户主目录之内', 'BAD_PATH')
        }
        if (!(await statDir(expanded))) throw httpError(400, '自定义技能库目录不存在', 'BAD_PATH')
        const key = slugLabel(item.key || basename(expanded))
        if (key === '') continue
        accepted.push({ key, label: typeof item.label === 'string' ? item.label : '', dir: expanded })
      }
      settings.customLibraries = accepted
    }
    scheduleSave()
    libCache = { at: 0, libs: [] }
    invalidateScan()
    const next = await buildState(false)
    sendJson(res, 200, { settings: state.settings, libraries: next.libraries, translateAvailable: next.translateAvailable })
    return
  }

  throw httpError(404, `未知接口：${key}`, 'NOT_FOUND')
}

async function currentCategories() {
  const scan = await getScan(false)
  return categoriesWithCounts(enrichedSkills(scan))
}

// ── 插件入口 ────────────────────────────────────────────────────────────

export function apply(ctx) {
  ctxRef = ctx
  loadState().catch(() => {})

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          const connection = ctx.get('connection')
          if (connection && typeof connection.requestRejection === 'function') {
            const rejection = connection.requestRejection(req)
            if (rejection !== undefined && rejection !== null) {
              res.writeHead(typeof rejection === 'number' ? rejection : 403)
              res.end()
              return
            }
          }
          await loadState()
          await handleRequest(req, res)
        } catch (err) {
          const status = err && typeof err.status === 'number' ? err.status : 500
          const code = err && err.code ? err.code : 'INTERNAL'
          const message = err && err.message ? err.message : '服务器内部错误'
          if (status >= 500 && ctx.logger && typeof ctx.logger.warn === 'function') {
            ctx.logger.warn(`dsh-skill-manager: ${req.method} ${req.url} -> ${message}`)
          }
          if (!res.headersSent) sendJson(res, status, { error: message, code })
          else {
            try {
              res.end()
            } catch {
              // ignore
            }
          }
        }
      },
    })
    return dispose
  }, 'dsh-skill-manager: api route')

  // 启动时补齐目录，失败不影响加载
  fsp.mkdir(MANAGER_DIR, { recursive: true }).catch(() => {})
}
