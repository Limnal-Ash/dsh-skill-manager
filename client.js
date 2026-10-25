/**
 * dsh-skill-manager - 浏览器端（client half）
 *
 * 无构建 loader 模块：window.__ModuleLoader__.load({ id, factory(require) })
 * 只依赖 react（可选 react-dom，仅用于对话框技能选择器的 portal；缺失即降级）。
 *
 * 三处 slot：
 *   1) sidebar.panellist  —— 侧栏图标（书本 + 齿轮）
 *   2) main（key=skill-manager）—— 中央工作台（本地技能库 / 我的分类 / 新增技能）
 *   3) conversation.input.left —— 对话框「技能」按钮 + 分类折叠选择器
 *
 * 接口契约见 README.md；颜色只用 --dsw-alias-* / --dsw-specific-* token。
 */
window.__ModuleLoader__.load({
  id: '@limnalash/dsh-skill-manager',
  factory: function (require) {
    'use strict';

    var ReactNS = require('react');
    var React = ReactNS && typeof ReactNS.createElement === 'function'
      ? ReactNS
      : (ReactNS && ReactNS.default && typeof ReactNS.default.createElement === 'function' ? ReactNS.default : null);
    if (!React) {
      throw new Error('dsh-skill-manager: 无法加载 react');
    }
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    // react-dom 仅用于 picker 的 createPortal；不可用时 picker 用 position:fixed 内联渲染。
    var ReactDOM = null;
    try {
      var reactDomModule = require('react-dom');
      if (reactDomModule && typeof reactDomModule.createPortal === 'function') {
        ReactDOM = reactDomModule;
      }
    } catch (reactDomError) {
      ReactDOM = null;
    }

    // ── 常量 ────────────────────────────────────────────────────────────────
    var API = '/skill-manager/api';
    var PANEL_ID = 'skill-manager';
    var PANEL_ORDER = 25;
    var PICKER_ID = 'skill-manager-picker';
    var PICKER_ORDER = 55;
    var RECENT_KEY = 'dsh-skill-manager-recent';
    var RECENT_MAX = 8;
    var TRANSLATE_BATCH = 6;
    var DEFAULT_CATEGORY = 'default';
    var PROVIDER_OPTIONS = [
      { value: 'auto', label: '自动（Google → Bing）' },
      { value: 'google', label: 'Google' },
      { value: 'bing', label: 'Bing' },
      { value: 'off', label: '关闭' }
    ];
    var CONFLICT_OPTIONS = [
      { value: 'skip', label: '跳过', hint: '保留已有技能，不写入' },
      { value: 'overwrite', label: '覆盖', hint: '先移入回收站，再写入新技能' },
      { value: 'rename', label: '重命名', hint: '以 name-2 的形式并存' }
    ];

    // ── 小工具 ──────────────────────────────────────────────────────────────
    function toArray(value) {
      return Array.isArray(value) ? value : [];
    }

    function str(value) {
      return value === null || value === undefined ? '' : String(value);
    }

    function cx() {
      var out = [];
      for (var i = 0; i < arguments.length; i += 1) {
        if (arguments[i]) out.push(arguments[i]);
      }
      return out.join(' ');
    }

    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    function formatTime(ms) {
      var time = Number(ms);
      if (!isFinite(time) || time <= 0) return '';
      var d = new Date(time);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    function formatDate(ms) {
      var time = Number(ms);
      if (!isFinite(time) || time <= 0) return '';
      var d = new Date(time);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    function formatBytes(bytes) {
      var n = Number(bytes);
      if (!isFinite(n) || n <= 0) return '0 B';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    function formatStars(stars) {
      var n = Number(stars);
      if (!isFinite(n) || n < 0) return '0';
      if (n < 1000) return String(n);
      return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    }

    function findCategory(categories, id) {
      var list = toArray(categories);
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].id === id) return list[i];
      }
      return null;
    }

    function categoryName(categories, id) {
      var found = findCategory(categories, id);
      if (found) return str(found.name);
      return id === DEFAULT_CATEGORY ? '默认分类' : '未分类';
    }

    function findLibrary(libraries, key) {
      var list = toArray(libraries);
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].key === key) return list[i];
      }
      return null;
    }

    function findSkill(state, key) {
      if (!state || !key) return null;
      var list = toArray(state.skills);
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].key === key) return list[i];
      }
      return null;
    }

    function hasCjk(value) {
      return /[\u3400-\u9fff]/.test(str(value));
    }

    function needsTranslation(skill) {
      if (!skill) return false;
      if (str(skill.descriptionZh) !== '') return false;
      if (skill.translated === true) return false;
      var description = str(skill.description);
      if (description === '') return false;
      var cjk = (description.match(/[\u3400-\u9fff]/g) || []).length;
      var visible = description.replace(/\s/g, '').length;
      if (visible === 0) return false;
      return cjk / visible < 0.2;
    }

    function skillDescription(skill) {
      if (!skill) return '';
      return str(skill.descriptionZh) !== '' ? str(skill.descriptionZh) : str(skill.description);
    }

    /** 列表标题：优先中文名，其次英文技能名。 */
    function skillTitle(skill) {
      if (!skill) return '';
      var alias = str(skill.displayName);
      return alias !== '' ? alias : str(skill.name);
    }

    function hasAlias(skill) {
      return str(skill && skill.displayName) !== '' && str(skill && skill.displayName) !== str(skill && skill.name);
    }

    /** 分页：两个技能列表共用，固定每页 30 个。 */
    var PAGE_SIZE = 30;

    function Pager(props) {
      var total = Number(props.total) || 0;
      var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      var page = Math.min(Math.max(1, Number(props.page) || 1), pages);
      if (total <= PAGE_SIZE) {
        return h('div', { className: 'sm-pager sm-pager-single' }, h('span', { className: 'sm-pager-info' }, '共 ' + total + ' 个'));
      }
      function go(next) {
        return function () { props.onPage(next); };
      }
      return h('div', { className: 'sm-pager' },
        h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-ghost', disabled: page <= 1, onClick: go(1) }, '首页'),
        h('button', { type: 'button', className: 'sm-btn sm-btn-small', disabled: page <= 1, onClick: go(page - 1) }, '上一页'),
        h('span', { className: 'sm-pager-info' }, '第 ' + page + ' / ' + pages + ' 页 · 共 ' + total + ' 个'),
        h('button', { type: 'button', className: 'sm-btn sm-btn-small', disabled: page >= pages, onClick: go(page + 1) }, '下一页'),
        h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-ghost', disabled: page >= pages, onClick: go(pages) }, '末页')
      );
    }

    function paginate(list, page) {
      var items = toArray(list);
      var pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
      var safe = Math.min(Math.max(1, Number(page) || 1), pages);
      return { items: items.slice((safe - 1) * PAGE_SIZE, safe * PAGE_SIZE), page: safe, pages: pages };
    }

    function invocableSkills(state) {
      return toArray(state && state.skills).filter(function (skill) {
        return skill && skill.invocable === true;
      });
    }

    function filterSkillList(list, query) {
      var q = str(query).trim().toLowerCase();
      var items = toArray(list);
      if (q === '') return items.slice();
      return items.filter(function (skill) {
        if (!skill) return false;
        var haystack = [
          skill.name, skill.relPath, skill.description, skill.descriptionZh,
          skill.scene, skill.libLabel, skill.category
        ].map(str).join('\n').toLowerCase();
        return haystack.indexOf(q) !== -1;
      });
    }

    function sortSkillList(list, sort) {
      var items = toArray(list).slice();
      items.sort(function (a, b) {
        if (!a || !b) return 0;
        if (sort === 'mtime') {
          return (Number(b.mtime) || 0) - (Number(a.mtime) || 0);
        }
        var left = str(a.name).toLowerCase();
        var right = str(b.name).toLowerCase();
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
      });
      return items;
    }

    function writableLibraries(state) {
      return toArray(state && state.libraries).filter(function (lib) {
        return lib && lib.writable === true && lib.present !== false;
      });
    }

    // ── 数据 store（模块级，工作台与选择器共享） ────────────────────────────
    var store = {
      state: null,
      loading: false,
      loaded: false,
      error: null,
      refreshing: null,
      listeners: new Set(),
      toasts: [],
      toastSeq: 0
    };

    function notify() {
      store.listeners.forEach(function (listener) {
        try {
          listener();
        } catch (listenerError) {
          // 单个订阅者异常不影响其它订阅者
        }
      });
    }

    function useStore() {
      var tick = useState(0);
      var bump = tick[1];
      useEffect(function () {
        var listener = function () {
          bump(function (n) { return n + 1; });
        };
        store.listeners.add(listener);
        return function () {
          store.listeners.delete(listener);
        };
      }, []);
      return store;
    }

    // ── HTTP ────────────────────────────────────────────────────────────────
    function request(method, path, body) {
      var options = { method: method, headers: { 'Content-Type': 'application/json' } };
      if (body !== undefined && body !== null) {
        options.body = JSON.stringify(body);
      }
      return fetch(API + path, options).catch(function () {
        var netError = new Error('网络请求失败，请检查连接后重试');
        netError.code = 'NETWORK';
        throw netError;
      }).then(function (response) {
        return response.text().then(function (rawText) {
          var data = null;
          if (rawText) {
            try {
              data = JSON.parse(rawText);
            } catch (parseError) {
              data = null;
            }
          }
          if (!response.ok) {
            var httpError = new Error((data && data.error) || ('请求失败（HTTP ' + response.status + '）'));
            httpError.code = (data && data.code) || 'INTERNAL';
            httpError.status = response.status;
            throw httpError;
          }
          return data || {};
        });
      });
    }

    var api = {
      get: function (path) { return request('GET', path); },
      post: function (path, body) { return request('POST', path, body); },
      patch: function (path, body) { return request('PATCH', path, body); },
      del: function (path, body) { return request('DELETE', path, body); }
    };

    function refresh(force) {
      if (store.refreshing) return store.refreshing;
      store.loading = true;
      notify();
      var promise = request('GET', '/state' + (force ? '?force=1' : '')).then(function (data) {
        store.state = data && typeof data === 'object' ? data : null;
        store.loaded = true;
        store.error = null;
      }).catch(function (requestError) {
        store.error = (requestError && requestError.message) || '加载技能库失败';
      }).then(function () {
        store.loading = false;
        store.refreshing = null;
        notify();
      });
      store.refreshing = promise;
      return promise;
    }

    function refreshQuietly(force) {
      refresh(force).catch(function () { /* refresh 内部已记录错误 */ });
    }

    // ── Toast ───────────────────────────────────────────────────────────────
    function dismissToast(id) {
      var next = store.toasts.filter(function (toast) { return toast.id !== id; });
      if (next.length !== store.toasts.length) {
        store.toasts = next;
        notify();
      }
    }

    function pushToast(message, options) {
      var opts = options || {};
      var id = store.toastSeq + 1;
      store.toastSeq = id;
      var duration = typeof opts.duration === 'number' ? opts.duration : 2500;
      var toast = {
        id: id,
        message: str(message) || '操作完成',
        kind: opts.kind || 'success',
        actionLabel: opts.actionLabel || null,
        onAction: typeof opts.onAction === 'function' ? opts.onAction : null
      };
      store.toasts = store.toasts.concat([toast]);
      notify();
      if (duration > 0) {
        setTimeout(function () { dismissToast(id); }, duration);
      }
      return id;
    }

    function failToast(error) {
      pushToast((error && error.message) || '操作失败，请重试', { kind: 'error', duration: 4000 });
    }

    // ── 自动翻译队列（面板挂载期间串行执行，卸载即停） ──────────────────────
    var translation = {
      running: false,
      cancelled: false,
      warned: false
    };

    function stopTranslation() {
      translation.cancelled = true;
    }

    function applyTranslationResults(result) {
      var state = store.state;
      if (!state || !result || !Array.isArray(result.results)) return;
      if (result.unavailable === true) {
        state.translateAvailable = false;
      }
      var patches = {};
      result.results.forEach(function (item) {
        if (item && item.key) patches[item.key] = item;
      });
      var changed = false;
      state.skills = toArray(state.skills).map(function (skill) {
        if (!skill || !patches[skill.key]) return skill;
        var patch = patches[skill.key];
        changed = true;
        var next = Object.assign({}, skill);
        if (patch.descriptionZh !== undefined) next.descriptionZh = patch.descriptionZh;
        if (patch.scene !== undefined) next.scene = patch.scene;
        if (patch.translated !== undefined) next.translated = patch.translated;
        return next;
      });
      if (changed) notify();
    }

    function startTranslation() {
      if (translation.running) return;
      var state = store.state;
      if (!state || !state.settings || state.settings.autoTranslate !== true) return;
      if (state.settings.translateProvider === 'off') return;
      if (state.translateAvailable === false) return;
      var keys = toArray(state.skills).filter(needsTranslation).map(function (skill) {
        return skill.key;
      });
      if (keys.length === 0) return;
      translation.running = true;
      translation.cancelled = false;
      var cursor = 0;

      function nextBatch() {
        if (translation.cancelled || cursor >= keys.length) {
          translation.running = false;
          return;
        }
        var batch = keys.slice(cursor, cursor + TRANSLATE_BATCH);
        cursor += TRANSLATE_BATCH;
        api.post('/translate', { keys: batch }).then(function (result) {
          if (translation.cancelled) {
            translation.running = false;
            return;
          }
          applyTranslationResults(result);
          if (result && result.unavailable === true) {
            // 通道不可用：停止队列并给出一次提示，避免逐批重复等待超时
            translation.running = false;
            if (store.state) store.state.translateAvailable = false;
            if (!translation.warned) {
              translation.warned = true;
              pushToast('翻译服务暂不可用，已暂停自动翻译（可稍后重新扫描或手动填写中文简介）', { kind: 'error', duration: 5000 });
            }
            return;
          }
          nextBatch();
        }).catch(function (error) {
          translation.running = false;
          if (!translation.warned) {
            translation.warned = true;
            pushToast((error && error.message) || '翻译服务暂不可用，已暂停自动翻译', { kind: 'error', duration: 4000 });
          }
        });
      }

      nextBatch();
    }

    // ── 剪贴板 ──────────────────────────────────────────────────────────────
    function copyText(value) {
      var content = str(value);
      if (content === '') return Promise.resolve(false);
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(content).then(function () {
          return true;
        }).catch(function () {
          return legacyCopy(content);
        });
      }
      return Promise.resolve(legacyCopy(content));
    }

    function legacyCopy(content) {
      try {
        if (typeof document === 'undefined') return false;
        var area = document.createElement('textarea');
        area.value = content;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        document.body.removeChild(area);
        return ok === true;
      } catch (copyError) {
        return false;
      }
    }

    // ── 样式注入 ────────────────────────────────────────────────────────────
    function ensureStyles() {
      try {
        if (typeof document === 'undefined') return;
        if (document.getElementById('sm-styles')) return;
        var styleElement = document.createElement('style');
        styleElement.id = 'sm-styles';
        styleElement.textContent = STYLE;
        (document.head || document.documentElement).appendChild(styleElement);
      } catch (styleError) {
        // 样式注入失败不阻塞渲染
      }
    }

    function useStyles() {
      useEffect(function () {
        ensureStyles();
      }, []);
    }

    // ── 样式（只允许 --dsw-* 主题 token 颜色） ──────────────────────────────
    var STYLE = `
.sm-root { position: relative; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--dsw-alias-bg-base); -webkit-backdrop-filter: blur(18px) saturate(1.08); backdrop-filter: blur(18px) saturate(1.08); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; font-family: inherit; }
.sm-root *, .sm-root *::before, .sm-root *::after { box-sizing: border-box; }
.sm-toolbar { flex: 0 0 48px; height: 48px; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.sm-title { font-size: 15px; font-weight: 600; white-space: nowrap; }
.sm-tabs { display: flex; align-items: center; gap: 4px; margin-left: 8px; }
.sm-tab { height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.sm-tab:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sm-tab[data-active="true"] { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); font-weight: 600; }
.sm-spacer { flex: 1 1 auto; min-width: 4px; }
.sm-search-wrap { position: relative; display: flex; align-items: center; }
.sm-search-icon { position: absolute; left: 8px; display: inline-flex; color: var(--dsw-alias-label-secondary); pointer-events: none; }
.sm-input { height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; min-width: 0; }
.sm-input::placeholder { color: var(--dsw-alias-label-secondary); }
.sm-search { width: 240px; padding-left: 28px; }
.sm-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.sm-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); filter: brightness(1.05); }
.sm-btn:disabled { opacity: 0.5; cursor: default; }
.sm-btn-primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); background: transparent; }
.sm-btn-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); background: transparent; }
.sm-btn-small { height: 24px; padding: 0 8px; font-size: 12px; }
.sm-btn-ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.sm-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); filter: none; }
.sm-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.sm-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sm-icon-btn:disabled { opacity: 0.5; cursor: default; }
.sm-tab:focus-visible, .sm-btn:focus-visible, .sm-icon-btn:focus-visible, .sm-input:focus-visible, .sm-select:focus-visible, .sm-switch:focus-visible, .sm-link-btn:focus-visible, .sm-cat-main:focus-visible, .sm-lib-card:focus-visible, .sm-picker-row:focus-visible, .sm-picker-group-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.sm-content { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
.sm-split { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
.sm-side { flex: 0 0 280px; width: 280px; min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--dsw-alias-border-l1); overflow: hidden; }
.sm-side-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sm-side-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.sm-main-col { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.sm-main-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.sm-main-title { font-size: 13px; font-weight: 600; }
.sm-main-count { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sm-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px 12px 24px; }
.sm-list-centered { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; align-items: center; justify-content: center; padding: 24px; }
.sm-pager { flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.sm-pager-single { justify-content: flex-end; }
.sm-pager-info { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0 4px; white-space: nowrap; }
.sm-skill-alias { font-family: inherit; font-weight: 400; font-size: 11px; color: var(--dsw-alias-label-secondary); margin-left: 2px; }
.sm-repo-skill-alias { flex: 0 0 132px; }
.sm-input-mini { height: 26px; padding: 0 8px; font-size: 12px; width: 100%; }
.sm-repo-skill-name-en { font-family: inherit; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.sm-picker-name-en { font-family: inherit; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.sm-lib-card { display: block; width: 100%; text-align: left; padding: 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; }
.sm-lib-card:hover { background: var(--dsw-alias-bg-layer-2); }
.sm-lib-card[data-active="true"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.sm-lib-top { display: flex; align-items: center; gap: 6px; }
.sm-lib-name { font-size: 13px; font-weight: 600; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-lib-count { font-size: 12px; color: var(--dsw-alias-label-secondary); flex: 0 0 auto; }
.sm-lib-dir { margin-top: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
.sm-lib-badges { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.sm-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }
.sm-badge-brand { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.sm-badge-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.sm-badge-success { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.sm-badge-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.sm-badge-idle { border-color: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-state-idle-primary); }
.sm-skill-row { position: relative; padding: 10px 12px; border-radius: 10px; border: 1px solid transparent; background: var(--dsw-alias-bg-layer-1); margin-bottom: 6px; display: flex; gap: 12px; align-items: flex-start; content-visibility: auto; }
.sm-skill-row:hover { border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.sm-skill-body { flex: 1 1 auto; min-width: 0; }
.sm-skill-line1 { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sm-skill-name { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.sm-skill-desc { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sm-skill-scene { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-skill-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; opacity: 0; transition: opacity 120ms ease; }
.sm-skill-row:hover .sm-skill-actions, .sm-skill-actions:focus-within { opacity: 1; }
.sm-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 40px 16px; color: var(--dsw-alias-label-secondary); text-align: center; font-size: 13px; }
.sm-empty-icon { color: var(--dsw-alias-label-secondary); opacity: 0.6; display: inline-flex; }
.sm-empty-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; }
.sm-error-box { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); font-size: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sm-warn-box { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
.sm-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sm-muted { color: var(--dsw-alias-label-secondary); }
.sm-error-text { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.sm-success-text { color: var(--dsw-alias-state-success-primary); font-size: 12px; }
.sm-warn-text { color: var(--dsw-alias-state-warn-primary); font-size: 12px; }
.sm-skeleton-row { height: 54px; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); margin-bottom: 6px; opacity: 0.7; }
.sm-loading-bar { flex: 0 0 auto; height: 2px; background: var(--dsw-alias-brand-primary); animation: sm-slide 1.2s ease-in-out infinite; }
@keyframes sm-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
.sm-spin { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: sm-spin 0.8s linear infinite; }
@keyframes sm-spin { to { transform: rotate(360deg); } }
.sm-cat-row { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.sm-cat-row:hover { background: var(--dsw-alias-bg-layer-2); }
.sm-cat-row[data-active="true"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.sm-cat-main { flex: 1 1 auto; min-width: 0; text-align: left; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; padding: 0; display: flex; align-items: center; gap: 6px; }
.sm-cat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-cat-count { color: var(--dsw-alias-label-secondary); font-size: 12px; flex: 0 0 auto; margin-left: auto; }
.sm-cat-meta { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.sm-cat-actions { display: none; align-items: center; gap: 4px; flex: 0 0 auto; }
.sm-cat-row:hover .sm-cat-actions, .sm-cat-row:focus-within .sm-cat-actions { display: flex; }
.sm-inline-edit { display: flex; align-items: center; gap: 6px; padding: 6px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.sm-inline-edit-col { flex-direction: column; align-items: stretch; gap: 6px; }
.sm-inline-edit-title { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sm-inline-edit-actions { display: flex; gap: 6px; justify-content: flex-end; }
.sm-inline-edit .sm-input { flex: 1 1 auto; height: 26px; }
.sm-page { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.sm-page-inner { width: 100%; max-width: 960px; margin: 0 auto; padding: 16px 24px 48px; display: flex; flex-direction: column; gap: 16px; }
.sm-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; }
.sm-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sm-card-title { font-size: 13px; font-weight: 600; }
.sm-card-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.sm-card-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap; }
.sm-row-input { display: flex; gap: 8px; align-items: center; }
.sm-row-input .sm-input { flex: 1 1 auto; height: 32px; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 12px; }
.sm-table { margin-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.sm-table-row { display: flex; align-items: center; gap: 8px; padding: 8px 4px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.sm-table-row:last-child { border-bottom: 0; }
.sm-check { flex: 0 0 auto; width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
.sm-repo-skill-name { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 12px; font-weight: 600; flex: 0 1 auto; min-width: 100px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-repo-skill-desc { flex: 1 1 auto; min-width: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-repo-skill-path { flex: 0 0 auto; color: var(--dsw-alias-label-secondary); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
.sm-progress { height: 4px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; margin-top: 8px; }
.sm-progress-bar { height: 100%; background: var(--dsw-alias-brand-primary); transition: width 160ms ease; }
.sm-drawer-overlay { position: absolute; inset: 0; z-index: 50; }
.sm-drawer-mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-overlay); opacity: 0.55; }
.sm-drawer { position: absolute; top: 0; right: 0; bottom: 0; width: 420px; max-width: 100%; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); border-left: 1px solid var(--dsw-alias-border-l1); }
.sm-drawer-head { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.sm-drawer-title { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.sm-drawer-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
.sm-drawer-foot { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.sm-field { display: flex; flex-direction: column; gap: 4px; }
.sm-field-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sm-field-value { font-size: 13px; word-break: break-word; }
.sm-textarea { width: 100%; min-height: 68px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; resize: vertical; }
.sm-textarea:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.sm-mono { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 12px; word-break: break-all; }
.sm-file-list { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow-y: auto; }
.sm-file-row { display: flex; align-items: center; gap: 8px; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.sm-file-size { margin-left: auto; flex: 0 0 auto; }
.sm-overlay { position: absolute; inset: 0; z-index: 70; display: flex; align-items: center; justify-content: center; padding: 24px; }
.sm-overlay-mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-overlay); opacity: 0.7; }
.sm-dialog { position: relative; z-index: 1; width: 440px; max-width: 100%; max-height: 100%; display: flex; flex-direction: column; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); color: var(--dsw-alias-label-primary); overflow: hidden; }
.sm-dialog-wide { width: 620px; }
.sm-dialog-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.sm-dialog-title { flex: 1 1 auto; font-size: 13px; font-weight: 600; }
.sm-dialog-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; font-size: 13px; }
.sm-dialog-foot { flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.sm-field-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; }
.sm-field-row + .sm-field-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.sm-field-row-label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sm-field-row-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.sm-select { height: 28px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; max-width: 100%; }
.sm-radio-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sm-radio-option { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); font-size: 12px; cursor: pointer; }
.sm-radio-option[data-active="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.sm-radio-option input { accent-color: var(--dsw-alias-brand-primary); margin: 0; }
.sm-switch { position: relative; flex: 0 0 auto; width: 36px; height: 20px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); cursor: pointer; padding: 0; }
.sm-switch[data-on="true"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.sm-switch-knob { position: absolute; top: 1px; left: 1px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary); transition: transform 120ms ease; }
.sm-switch[data-on="true"] .sm-switch-knob { transform: translateX(16px); }
.sm-trash-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.sm-trash-name { flex: 1 1 160px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-trash-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; flex: 0 0 auto; }
.sm-toasts { position: absolute; right: 16px; bottom: 16px; z-index: 90; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
.sm-toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; min-width: 180px; max-width: 360px; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; }
.sm-toast[data-kind="error"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.sm-toast[data-kind="success"] { border-color: var(--dsw-alias-state-success-primary); }
.sm-toast-text { flex: 1 1 auto; min-width: 0; word-break: break-word; }
.sm-toast-action { flex: 0 0 auto; border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
.sm-chip { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.sm-chip:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sm-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.sm-picker-backdrop { position: fixed; inset: 0; z-index: 2147483000; background: transparent; }
.sm-picker { position: fixed; z-index: 2147483001; width: 380px; max-width: calc(100vw - 16px); max-height: 420px; display: flex; flex-direction: column; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); color: var(--dsw-alias-label-primary); overflow: hidden; font-size: 13px; }
.sm-picker-search { flex: 0 0 auto; padding: 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.sm-picker-search .sm-input { width: 100%; }
.sm-picker-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 6px; }
.sm-picker-group { margin-bottom: 2px; }
.sm-picker-group-head { width: 100%; display: flex; align-items: center; gap: 4px; padding: 5px 6px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; text-align: left; }
.sm-picker-group-head:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sm-picker-group-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-picker-row { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 20px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.sm-picker-row:hover { background: var(--dsw-alias-bg-layer-2); }
.sm-picker-row[data-active="true"] { background: var(--dsw-alias-bg-layer-2); box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); }
.sm-picker-name { flex: 0 0 auto; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 12px; font-weight: 600; }
.sm-picker-desc { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.sm-picker-empty { padding: 24px 12px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.sm-picker-foot { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-top: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 11px; flex-wrap: wrap; }
.sm-kbd { display: inline-flex; align-items: center; padding: 0 4px; height: 16px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); font-size: 10px; }
.sm-divider { height: 1px; background: var(--dsw-alias-border-l1); }
.sm-clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 1100px) { .sm-side { flex-basis: 220px; width: 220px; } .sm-search { width: 160px; } }
@media (prefers-reduced-motion: reduce) { .sm-spin, .sm-loading-bar { animation: none; } }
`;

    // ── 局部状态更新 ────────────────────────────────────────────────────────
    function applySkillPatches(patches) {
      var state = store.state;
      if (!state || !Array.isArray(patches)) return;
      var patchMap = {};
      patches.forEach(function (patch) {
        if (patch && patch.key) patchMap[patch.key] = patch;
      });
      var changed = false;
      state.skills = toArray(state.skills).map(function (skill) {
        if (!skill || !patchMap[skill.key]) return skill;
        changed = true;
        return Object.assign({}, skill, patchMap[skill.key]);
      });
      if (changed) notify();
    }

    function applyCategories(categories) {
      if (!store.state || !Array.isArray(categories)) return;
      store.state.categories = categories;
      notify();
    }

    function applyLibraries(libraries) {
      if (!store.state || !Array.isArray(libraries)) return;
      store.state.libraries = libraries;
      notify();
    }

    function applyTrash(items) {
      if (!store.state || !Array.isArray(items)) return;
      store.state.trash = items;
      notify();
    }

    function applyRepos(repos) {
      if (!store.state || !Array.isArray(repos)) return;
      store.state.repos = repos;
      notify();
    }

    function applyInstalls(installs) {
      if (!store.state || !installs || typeof installs !== 'object') return;
      store.state.installs = installs;
      notify();
    }

    // ── 变更动作（成功后就地更新 store，必要时后台重扫） ────────────────────
    function copySkill(skill, toLib, onConflict) {
      return api.post('/copy', { key: skill.key, toLib: toLib, onConflict: onConflict }).then(function (result) {
        var targetLib = findLibrary(store.state && store.state.libraries, toLib);
        var targetLabel = targetLib ? str(targetLib.label) : str(toLib);
        if (result && result.action === 'skipped') {
          pushToast('目标库已有同名技能，已跳过');
        } else {
          var message = '已复制到「' + targetLabel + '」';
          if (result && result.renamed) message += '（重命名为 ' + result.renamed + '）';
          pushToast(message);
        }
        refreshQuietly(true);
        return result;
      });
    }

    function deleteSkill(skill) {
      return api.post('/delete', { key: skill.key }).then(function (result) {
        applyTrash(result && result.trash);
        refreshQuietly(true);
        var trashId = result && result.trashId;
        pushToast('已将「' + skill.name + '」移入回收站', {
          duration: 5000,
          actionLabel: '撤销',
          onAction: function () {
            if (!trashId) return;
            api.post('/trash/restore', { id: trashId }).then(function (restored) {
              applyTrash(restored && restored.trash);
              pushToast('已恢复「' + skill.name + '」');
              refreshQuietly(true);
            }).catch(failToast);
          }
        });
        return result;
      });
    }

    function assignCategory(skill, categoryId) {
      return api.patch('/assign', { key: skill.key, categoryId: categoryId }).then(function (result) {
        if (result && result.skills) applySkillPatches(result.skills);
        if (result && result.categories) applyCategories(result.categories);
        if (categoryId === null || categoryId === undefined) {
          pushToast('已恢复自动归类');
        } else {
          pushToast('已归类到「' + categoryName(store.state && store.state.categories, categoryId) + '」');
        }
        return result;
      });
    }

    /** 手动触发「自动整理」：按本机实际技能重建自动分类（自定义分类和手动归类保留）。 */
    function organizeCategoriesNow() {
      return api.post('/organize', {}).then(function (result) {
        applyCategories(result && result.categories);
        if (result && result.skills) applySkillPatches(result.skills);
        var created = toArray(result && result.created);
        var names = created.map(function (item) { return item.name + '(' + item.count + ')'; });
        if (names.length > 0) {
          pushToast('已自动生成 ' + names.length + ' 个分类：' + names.join('、'), { duration: 4000 });
        } else {
          pushToast('本机技能没有命中可单独成类的主题', { duration: 3500 });
        }
        refreshQuietly(true);
        return result;
      });
    }

    function createCategory(name) {
      return api.post('/categories', { name: name }).then(function (result) {
        applyCategories(result && result.categories);
        pushToast('已新增分类「' + name + '」');
        return result;
      });
    }

    function renameCategory(id, name) {
      return api.patch('/categories', { id: id, name: name }).then(function (result) {
        applyCategories(result && result.categories);
        pushToast('已重命名分类');
        return result;
      });
    }

    function updateCategoryRules(id, keywords) {
      return api.patch('/categories', { id: id, keywords: keywords }).then(function (result) {
        applyCategories(result && result.categories);
        pushToast('已保存「' + categoryName(store.state && store.state.categories, id) + '」的识别关键词');
        refreshQuietly(true);
        return result;
      });
    }

    function deleteCategory(category) {
      return api.del('/categories', { id: category.id }).then(function (result) {
        applyCategories(result && result.categories);
        pushToast('已删除分类「' + category.name + '」');
        refreshQuietly(true);
        return result;
      });
    }

    function overrideSkill(skill, patch) {
      var body = Object.assign({ key: skill.key }, patch);
      return api.patch('/override', body).then(function (result) {
        if (result && result.skills) applySkillPatches(result.skills);
        pushToast('已保存修改');
        return result;
      });
    }

    function restoreTrash(id) {
      return api.post('/trash/restore', { id: id }).then(function (result) {
        applyTrash(result && result.trash);
        pushToast('已恢复技能');
        refreshQuietly(true);
        return result;
      });
    }

    function purgeTrash(id) {
      return api.post('/trash/purge', { id: id }).then(function (result) {
        applyTrash(result && result.trash);
        pushToast('已彻底删除');
        return result;
      });
    }

    function saveSettings(patch) {
      return api.patch('/settings', patch).then(function (result) {
        var state = store.state;
        if (state) {
          if (result && result.settings) state.settings = result.settings;
          if (result && result.libraries) state.libraries = result.libraries;
          notify();
        }
        var settings = (result && result.settings) || (state && state.settings) || {};
        if (settings.autoTranslate === true) {
          startTranslation();
        } else {
          stopTranslation();
        }
        return result;
      });
    }

    function recognizeRepo(url) {
      return api.post('/repos/recognize', { url: url });
    }

    function saveRepo(url) {
      return api.post('/repos', { url: url }).then(function (result) {
        applyRepos(result && result.repos);
        pushToast('已保存仓库');
        return result;
      });
    }

    function refreshRepo(id) {
      return api.post('/repos/refresh', { id: id }).then(function (result) {
        applyRepos(result && result.repos);
        return result;
      });
    }

    function deleteRepo(id) {
      return api.del('/repos', { id: id }).then(function (result) {
        applyRepos(result && result.repos);
        pushToast('已删除仓库');
        return result;
      });
    }

    function installRepoSkill(repoId, skillPath, toLib, onConflict, displayName) {
      return api.post('/install', {
        repoId: repoId,
        skillPath: skillPath,
        toLib: toLib,
        onConflict: onConflict,
        displayName: displayName || ''
      });
    }

    /** 给已安装技能设置/清除中文名（按技能英文名索引，跨库共享）。 */
    function setSkillAlias(name, displayName) {
      return api.patch('/alias', { name: name, displayName: displayName }).then(function (result) {
        if (result && result.skills) applySkillPatches(result.skills);
        if (result && result.aliases && store.state) store.state.aliases = result.aliases;
        pushToast(displayName ? '已设置中文名「' + displayName + '」' : '已清除中文名');
        return result;
      });
    }

    /** 给仓库里待安装的技能设置中文名，安装时会自动带上。 */
    function setRepoAlias(repoId, skillPath, displayName) {
      return api.patch('/alias', { repoId: repoId, path: skillPath, displayName: displayName }).then(function (result) {
        if (result && result.repos) applyRepos(result.repos);
        if (result && result.repoAliases && store.state) store.state.repoAliases = result.repoAliases;
        pushToast(displayName ? '已设置中文名「' + displayName + '」' : '已清除中文名');
        return result;
      });
    }

    // ── SVG 图标 ────────────────────────────────────────────────────────────
    function iconProps(size, viewBox) {
      return {
        viewBox: viewBox || '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false'
      };
    }

    function PanelIcon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 16;
      var attrs = iconProps(size, '0 0 24 24');
      attrs.strokeWidth = 1.5;
      attrs['data-dsh-panel-entry'] = PANEL_ID;
      attrs['data-active'] = props && props.active ? 'true' : 'false';
      return h('svg', attrs,
        h('path', { d: 'M4 4.5A1.5 1.5 0 0 1 5.5 3H10a2.5 2.5 0 0 1 2 1 2.5 2.5 0 0 1 2-1h4.5A1.5 1.5 0 0 1 20 4.5v12A1.5 1.5 0 0 1 18.5 18H14a2.5 2.5 0 0 0-2 1 2.5 2.5 0 0 0-2-1H5.5A1.5 1.5 0 0 1 4 16.5z' }),
        h('path', { d: 'M12 4v15' }),
        h('circle', { cx: 17.6, cy: 17.4, r: 2.6 }),
        h('path', { d: 'M17.6 15.4v-.7M17.6 19.4v-.7M19.6 17.4h-.7M15.6 17.4h-.7M19 16l-.5.5M16.2 18.8l.5-.5M19 18.8l-.5-.5M16.2 16l.5.5' })
      );
    }

    function IconSearch(props) {
      var size = props && props.size ? props.size : 14;
      return h('svg', iconProps(size),
        h('circle', { cx: 7, cy: 7, r: 4.2 }),
        h('path', { d: 'M10.1 10.1 13.6 13.6' })
      );
    }

    function IconRefresh(props) {
      var size = props && props.size ? props.size : 14;
      return h('svg', iconProps(size),
        h('path', { d: 'M13.4 8A5.4 5.4 0 1 1 11.6 3.9' }),
        h('path', { d: 'M13.4 3.6v3.3H10.1' })
      );
    }

    function IconGear(props) {
      var size = props && props.size ? props.size : 14;
      return h('svg', iconProps(size),
        h('circle', { cx: 8, cy: 8, r: 2.2 }),
        h('path', { d: 'M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2' })
      );
    }

    function IconClose(props) {
      var size = props && props.size ? props.size : 12;
      return h('svg', iconProps(size), h('path', { d: 'M3.5 3.5l9 9M12.5 3.5l-9 9' }));
    }

    function IconChevron(props) {
      var size = props && props.size ? props.size : 12;
      var open = props && props.open === true;
      var attrs = iconProps(size, '0 0 12 12');
      attrs.style = { transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 120ms ease', flex: '0 0 auto' };
      return h('svg', attrs, h('path', { d: 'M4.5 2.5 8 6l-3.5 3.5' }));
    }

    function IconBook(props) {
      var size = props && props.size ? props.size : 28;
      return h('svg', iconProps(size),
        h('path', { d: 'M8 3.2C6.6 2 4.5 2 3 2v10.5c1.5 0 3.6 0 5 1.3 1.4-1.3 3.5-1.3 5-1.3V2c-1.5 0-3.6 0-5 1.2z' }),
        h('path', { d: 'M8 3.2v10.6' })
      );
    }

    function IconBolt(props) {
      var size = props && props.size ? props.size : 13;
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'currentColor', stroke: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M9.2 1.6 3.8 9h3.4l-.8 5.4L12.2 7H8.8z' })
      );
    }

    // ── 通用小组件 ──────────────────────────────────────────────────────────
    function Spinner() {
      return h('span', { className: 'sm-spin', 'aria-hidden': 'true' });
    }

    function Switch(props) {
      var checked = props && props.checked === true;
      return h('button', {
        type: 'button',
        className: 'sm-switch',
        'data-on': checked ? 'true' : 'false',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': (props && props.label) || '开关',
        disabled: props && props.disabled === true,
        onClick: function () {
          if (props && typeof props.onChange === 'function' && props.disabled !== true) {
            props.onChange(!checked);
          }
        }
      }, h('span', { className: 'sm-switch-knob' }));
    }

    function Badge(props) {
      var tone = props && props.tone ? 'sm-badge-' + props.tone : null;
      return h('span', { className: cx('sm-badge', tone), title: (props && props.title) || undefined }, props && props.children);
    }

    function LoadingBar() {
      return h('div', { className: 'sm-loading-bar', role: 'progressbar', 'aria-label': '加载中' });
    }

    function SkeletonRows(props) {
      var count = props && props.count ? props.count : 5;
      var rows = [];
      for (var i = 0; i < count; i += 1) {
        rows.push(h('div', { key: 'skeleton-' + i, className: 'sm-skeleton-row' }));
      }
      return h('div', { className: 'sm-list', 'aria-hidden': 'true' }, rows);
    }

    function ErrorBox(props) {
      return h('div', { className: 'sm-error-box', role: 'alert' },
        h('span', null, props && props.message ? props.message : '加载失败'),
        props && typeof props.onRetry === 'function'
          ? h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-danger', onClick: props.onRetry }, '重试')
          : null
      );
    }

    function EmptyState(props) {
      return h('div', { className: 'sm-empty' },
        props && props.icon === false ? null : h('span', { className: 'sm-empty-icon' }, (props && props.icon) || h(IconBook, { size: 28 })),
        props && props.title ? h('div', { className: 'sm-empty-title' }, props.title) : null,
        props && props.description ? h('div', null, props.description) : null,
        props && props.actionLabel
          ? h('button', { type: 'button', className: 'sm-btn sm-btn-primary', onClick: props.onAction }, props.actionLabel)
          : null
      );
    }

    function FieldRow(props) {
      return h('div', { className: 'sm-field-row' },
        h('div', { className: 'sm-field-row-label' },
          h('span', null, props && props.label ? props.label : ''),
          props && props.hint ? h('span', { className: 'sm-field-row-hint' }, props.hint) : null
        ),
        h('div', null, props && props.children)
      );
    }

    function ModalShell(props) {
      var close = props && typeof props.onClose === 'function' ? props.onClose : function () {};
      return h('div', {
        className: 'sm-overlay',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) close();
        }
      },
        h('div', {
          className: 'sm-overlay-mask',
          onMouseDown: function () { close(); }
        }),
        h('div', {
          className: cx('sm-dialog', props && props.wide ? 'sm-dialog-wide' : null),
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': props && props.title ? props.title : '对话框'
        },
          h('div', { className: 'sm-dialog-head' },
            h('div', { className: 'sm-dialog-title' }, props && props.title),
            h('button', { type: 'button', className: 'sm-icon-btn', 'aria-label': '关闭', onClick: close }, h(IconClose, { size: 13 }))
          ),
          h('div', { className: 'sm-dialog-body' }, props && props.children),
          props && props.footer ? h('div', { className: 'sm-dialog-foot' }, props.footer) : null
        )
      );
    }

    function ToastViewport() {
      useStore();
      if (store.toasts.length === 0) return null;
      return h('div', { className: 'sm-toasts', 'aria-live': 'polite' }, store.toasts.map(function (toast) {
        return h('div', { key: toast.id, className: 'sm-toast', 'data-kind': toast.kind, role: 'status' },
          h('span', { className: 'sm-toast-text' }, toast.message),
          toast.actionLabel
            ? h('button', {
              type: 'button',
              className: 'sm-toast-action',
              onClick: function () {
                dismissToast(toast.id);
                if (toast.onAction) {
                  try {
                    toast.onAction();
                  } catch (actionError) {
                    failToast(actionError);
                  }
                }
              }
            }, toast.actionLabel)
            : null,
          h('button', {
            type: 'button',
            className: 'sm-icon-btn sm-btn-small',
            'aria-label': '关闭提示',
            onClick: function () { dismissToast(toast.id); }
          }, h(IconClose, { size: 11 }))
        );
      }));
    }

    // ── 主面板：技能管理 ────────────────────────────────────────────────────
    var TAB_ITEMS = [
      { key: 'lib', label: '本地技能库' },
      { key: 'cat', label: '我的分类' },
      { key: 'new', label: '新增技能' }
    ];

    function Workbench() {
      useStyles();
      useStore();

      var tabState = useState('lib');
      var tab = tabState[0];
      var setTab = tabState[1];
      var searchState = useState('');
      var searchInput = searchState[0];
      var setSearchInput = searchState[1];
      var queryState = useState('');
      var query = queryState[0];
      var setQuery = queryState[1];
      var sortState = useState('name');
      var sort = sortState[0];
      var setSort = sortState[1];
      var libState = useState(null);
      var libKey = libState[0];
      var setLibKey = libState[1];
      var catState = useState(DEFAULT_CATEGORY);
      var categoryId = catState[0];
      var setCategoryId = catState[1];
      var drawerState = useState(null);
      var drawerKey = drawerState[0];
      var setDrawerKey = drawerState[1];
      var modalState = useState(null);
      var modal = modalState[0];
      var setModal = modalState[1];
      var rescanState = useState(false);
      var rescanning = rescanState[0];
      var setRescanning = rescanState[1];
      var startedRef = useRef(false);

      useEffect(function () {
        if (!startedRef.current) {
          startedRef.current = true;
          refresh(false);
        }
        return function () {
          stopTranslation();
        };
      }, []);

      useEffect(function () {
        var currentState = store.state;
        if (!currentState) return;
        if (currentState.settings && currentState.settings.autoTranslate === true) {
          startTranslation();
        }
      }, [store.state]);

      useEffect(function () {
        var timer = setTimeout(function () {
          setQuery(searchInput.trim());
        }, 150);
        return function () {
          clearTimeout(timer);
        };
      }, [searchInput]);

      useEffect(function () {
        function onKeyDown(event) {
          if (!event || event.key !== 'Escape') return;
          if (modal) {
            setModal(null);
          } else if (drawerKey) {
            setDrawerKey(null);
          } else if (searchInput !== '') {
            setSearchInput('');
          }
        }
        if (typeof document !== 'undefined') {
          document.addEventListener('keydown', onKeyDown);
        }
        return function () {
          if (typeof document !== 'undefined') {
            document.removeEventListener('keydown', onKeyDown);
          }
        };
      }, [modal, drawerKey, searchInput]);

      var state = store.state;
      var libraries = toArray(state && state.libraries);
      var categories = toArray(state && state.categories);
      var currentLib = findLibrary(libraries, libKey);
      if (!currentLib) {
        var fallbackLib = null;
        for (var libIndex = 0; libIndex < libraries.length; libIndex += 1) {
          if (libraries[libIndex] && libraries[libIndex].writable === true && libraries[libIndex].present !== false) {
            fallbackLib = libraries[libIndex];
            break;
          }
        }
        if (!fallbackLib && libraries.length > 0) fallbackLib = libraries[0];
        currentLib = fallbackLib;
      }
      var currentCategory = findCategory(categories, categoryId);
      if (!currentCategory && categories.length > 0) currentCategory = categories[0];
      var drawerSkill = drawerKey ? findSkill(state, drawerKey) : null;

      function closeModal() {
        setModal(null);
      }

      function openDetail(skillKeyValue) {
        setDrawerKey(skillKeyValue);
        setModal(null);
      }

      function openDialog(type, skillKeyValue) {
        setDrawerKey(null);
        setModal({ type: type, skillKey: skillKeyValue });
      }

      function handleRescan() {
        setRescanning(true);
        refresh(true).then(function () {
          setRescanning(false);
          if (store.error) {
            failToast(new Error(store.error));
          } else {
            pushToast('已重新扫描技能库');
          }
        });
      }

      function renderTabContent() {
        if (!state) return null;
        if (tab === 'cat') {
          return h(CategoryTab, {
            state: state,
            query: query,
            categories: categories,
            selectedCategory: currentCategory,
            onSelectCategory: setCategoryId,
            onOpenDetail: openDetail,
            onCopy: function (skillKeyValue) { openDialog('copy', skillKeyValue); },
            onMove: function (skillKeyValue) { openDialog('move', skillKeyValue); },
            onDelete: function (skillKeyValue) { openDialog('delete', skillKeyValue); },
            onDeleteCategory: function (categoryIdValue) { setModal({ type: 'category-delete', categoryId: categoryIdValue }); },
            onUpdateRules: updateCategoryRules
          });
        }
        if (tab === 'new') {
          return h(RepoTab, { state: state, query: query });
        }
        return h(LibraryTab, {
          state: state,
          query: query,
          sort: sort,
          selectedLib: currentLib,
          onSelectLib: setLibKey,
          onSortChange: setSort,
          onOpenDetail: openDetail,
          onCopy: function (skillKeyValue) { openDialog('copy', skillKeyValue); },
          onMove: function (skillKeyValue) { openDialog('move', skillKeyValue); },
          onDelete: function (skillKeyValue) { openDialog('delete', skillKeyValue); },
          onGoNew: function () { setTab('new'); }
        });
      }

      var modalNode = null;
      if (modal && modal.type === 'settings') {
        modalNode = h(SettingsDialog, { state: state, onClose: closeModal });
      } else if (modal && modal.type === 'copy') {
        var copyTarget = findSkill(state, modal.skillKey);
        modalNode = copyTarget ? h(CopyDialog, { skill: copyTarget, state: state, onClose: closeModal }) : null;
      } else if (modal && modal.type === 'move') {
        var moveTarget = findSkill(state, modal.skillKey);
        modalNode = moveTarget ? h(MoveDialog, { skill: moveTarget, state: state, onClose: closeModal }) : null;
      } else if (modal && modal.type === 'delete') {
        var deleteTarget = findSkill(state, modal.skillKey);
        modalNode = deleteTarget ? h(DeleteDialog, { skill: deleteTarget, state: state, onClose: closeModal }) : null;
      } else if (modal && modal.type === 'category-delete') {
        var categoryTarget = findCategory(categories, modal.categoryId);
        modalNode = categoryTarget ? h(CategoryDeleteDialog, { category: categoryTarget, onClose: closeModal }) : null;
      }

      return h('div', { className: 'sm-root', 'data-dsh-plugin': 'skill-manager' },
        h('div', { className: 'sm-toolbar' },
          h('div', { className: 'sm-title' }, '技能管理'),
          h('div', { className: 'sm-tabs', role: 'tablist' }, TAB_ITEMS.map(function (item) {
            return h('button', {
              key: item.key,
              type: 'button',
              role: 'tab',
              className: 'sm-tab',
              'data-active': tab === item.key ? 'true' : 'false',
              'aria-selected': tab === item.key,
              onClick: function () { setTab(item.key); }
            }, item.label);
          })),
          h('div', { className: 'sm-spacer' }),
          h('label', { className: 'sm-search-wrap' },
            h('span', { className: 'sm-search-icon' }, h(IconSearch, { size: 13 })),
            h('input', {
              className: 'sm-input sm-search',
              type: 'search',
              value: searchInput,
              placeholder: '搜索技能名称或简介…',
              'aria-label': '搜索技能',
              onChange: function (event) { setSearchInput(event.target.value); }
            })
          ),
          h('button', {
            type: 'button',
            className: 'sm-icon-btn',
            title: '重新扫描',
            'aria-label': '重新扫描',
            disabled: rescanning || store.loading,
            onClick: handleRescan
          }, rescanning ? h(Spinner) : h(IconRefresh, { size: 15 })),
          h('button', {
            type: 'button',
            className: 'sm-icon-btn',
            title: '设置',
            'aria-label': '设置',
            onClick: function () { setModal({ type: 'settings' }); }
          }, h(IconGear, { size: 15 }))
        ),
        store.loading ? h(LoadingBar) : null,
        !state && store.error
          ? h('div', { className: 'sm-list-centered' }, h(ErrorBox, { message: store.error, onRetry: function () { refresh(false); } }))
          : null,
        !state && !store.error
          ? h(SkeletonRows, { count: 6 })
          : null,
        state ? h('div', { className: 'sm-content' }, renderTabContent()) : null,
        drawerSkill ? h(DetailDrawer, {
          skill: drawerSkill,
          state: state,
          onClose: function () { setDrawerKey(null); },
          onCopy: function (skillKeyValue) { openDialog('copy', skillKeyValue); },
          onMove: function (skillKeyValue) { openDialog('move', skillKeyValue); },
          onDelete: function (skillKeyValue) { openDialog('delete', skillKeyValue); }
        }) : null,
        modalNode,
        h(ToastViewport)
      );
    }

    // ── Tab 1：本地技能库 ──────────────────────────────────────────────────
    function LibraryTab(props) {
      var state = props.state;
      var libraries = toArray(state && state.libraries);
      var selectedLib = props.selectedLib;
      var allSkills = toArray(state && state.skills);
      var libSkills = allSkills.filter(function (skill) {
        return skill && selectedLib && skill.lib === selectedLib.key;
      });
      var filtered = sortSkillList(filterSkillList(libSkills, props.query), props.sort);
      var readonlyLib = selectedLib ? selectedLib.writable === false : false;
      var pageHook = useState(1);
      var page = pageHook[0];
      var setPage = pageHook[1];
      useEffect(function () { setPage(1); }, [selectedLib ? selectedLib.key : '', props.sort, props.query]);
      var paged = paginate(filtered, page);

      return h('div', { className: 'sm-split' },
        h('div', { className: 'sm-side' },
          h('div', { className: 'sm-side-head' },
            h('span', null, '软件库'),
            h('span', { className: 'sm-spacer' }),
            h('span', null, libraries.length + ' 个')
          ),
          h('div', { className: 'sm-side-list' }, libraries.map(function (lib) {
            if (!lib) return null;
            var active = selectedLib && selectedLib.key === lib.key;
            return h('button', {
              key: lib.key,
              type: 'button',
              className: 'sm-lib-card',
              'data-active': active ? 'true' : 'false',
              title: str(lib.dir) || str(lib.displayDir),
              onClick: function () { props.onSelectLib(lib.key); }
            },
              h('span', { className: 'sm-lib-top' },
                h('span', { className: 'sm-lib-name' }, str(lib.label) || str(lib.key)),
                h('span', { className: 'sm-lib-count' }, (Number(lib.count) || 0) + ' 个')
              ),
              h('span', { className: 'sm-lib-dir', title: str(lib.dir) || str(lib.displayDir) }, str(lib.displayDir) || str(lib.dir)),
              h('span', { className: 'sm-lib-badges' },
                lib.writable === false ? h(Badge, { tone: 'idle' }, '只读') : null,
                lib.auto === true ? h(Badge, null, '自动发现') : null,
                lib.error ? h(Badge, { tone: 'error' }, '扫描失败') : null
              )
            );
          }))
        ),
        h('div', { className: 'sm-main-col' },
          h('div', { className: 'sm-main-head' },
            h('span', { className: 'sm-main-title' },
              selectedLib
                ? str(selectedLib.label) + ' · ' + (Number(selectedLib.count) || 0) + ' 个技能'
                : '本地技能库'
            ),
            filtered.length !== libSkills.length
              ? h('span', { className: 'sm-main-count' }, '筛选出 ' + filtered.length + ' 个')
              : null,
            h('span', { className: 'sm-spacer' }),
            h('select', {
              className: 'sm-select',
              value: props.sort,
              'aria-label': '排序方式',
              onChange: function (event) { props.onSortChange(event.target.value); }
            },
              h('option', { value: 'name' }, '按名称'),
              h('option', { value: 'mtime' }, '按最近修改')
            )
          ),
          selectedLib && selectedLib.error
            ? h('div', { className: 'sm-list' }, h(ErrorBox, { message: selectedLib.error }))
            : null,
          h('div', { className: 'sm-list' },
            !selectedLib
              ? h(EmptyState, { title: '还没有发现技能库', description: '可在设置里检查技能目录配置。' })
              : filtered.length === 0
                ? h(EmptyState, {
                  title: libSkills.length === 0 ? '这个软件库还没有技能' : '没有匹配的技能',
                  description: libSkills.length === 0 ? '可到「新增技能」从仓库地址添加。' : null,
                  actionLabel: libSkills.length === 0 ? '去新增技能' : null,
                  onAction: props.onGoNew
                })
                : paged.items.map(function (skill) {
                  return h(SkillRow, {
                    key: skill.key,
                    skill: skill,
                    state: state,
                    readonlyLib: readonlyLib,
                    moveLabel: '归类到…',
                    onOpen: props.onOpenDetail,
                    onCopy: props.onCopy,
                    onMove: props.onMove,
                    onDelete: props.onDelete
                  });
                })
          ),
          filtered.length === 0 ? null : h(Pager, { total: filtered.length, page: paged.page, onPage: setPage })
        )
      );
    }

    function SkillRow(props) {
      var skill = props.skill;
      var state = props.state;
      var readonlyLib = props.readonlyLib === true;
      var description = skillDescription(skill);
      var pending = needsTranslation(skill);
      var categoryLabel = categoryName(state && state.categories, skill.category);

      function openDetail(event) {
        if (event && event.target && typeof event.target.closest === 'function' && event.target.closest('button')) {
          return;
        }
        props.onOpen(skill.key);
      }

      return h('div', {
        className: 'sm-skill-row',
        onClick: openDetail,
        title: str(skill.descriptionZh) || str(skill.description)
      },
        h('div', { className: 'sm-skill-body' },
          h('div', { className: 'sm-skill-line1' },
            h('span', { className: 'sm-skill-name', title: str(skill.name) },
              skillTitle(skill),
              hasAlias(skill) ? h('span', { className: 'sm-skill-alias' }, '（' + str(skill.name) + '）') : null),
            h(Badge, { tone: 'brand' }, str(skill.libLabel) || str(skill.lib)),
            skill.categoryManual === true
              ? h(Badge, { tone: 'warn', title: '手动归类' }, categoryLabel)
              : h(Badge, null, categoryLabel)
          ),
          h('div', { className: 'sm-skill-desc', title: description },
            description || '（暂无简介）',
            pending ? h('span', { className: 'sm-badge sm-badge-warn', style: { marginLeft: '6px' } }, '待翻译') : null
          ),
          skill.scene
            ? h('div', { className: 'sm-skill-scene', title: str(skill.scene) }, '适用：' + str(skill.scene))
            : null
        ),
        h('div', { className: 'sm-skill-actions' },
          readonlyLib ? null : h('button', {
            type: 'button',
            className: 'sm-btn sm-btn-small',
            onClick: function () { props.onCopy(skill.key); }
          }, '复制到…'),
          h('button', {
            type: 'button',
            className: 'sm-btn sm-btn-small',
            onClick: function () { props.onMove(skill.key); }
          }, props.moveLabel || '归类到…'),
          h('button', {
            type: 'button',
            className: 'sm-btn sm-btn-small',
            onClick: function () { props.onOpen(skill.key); }
          }, '详情'),
          readonlyLib ? null : h('button', {
            type: 'button',
            className: 'sm-btn sm-btn-small sm-btn-danger',
            onClick: function () { props.onDelete(skill.key); }
          }, '删除')
        )
      );
    }

    // ── Tab 2：我的分类 ────────────────────────────────────────────────────
    function isReadonlySkill(state, skill) {
      var lib = findLibrary(state && state.libraries, skill && skill.lib);
      return !lib || lib.writable === false;
    }

    function formatWhen(value) {
      if (typeof value === 'number') return formatTime(value);
      var raw = str(value);
      if (raw === '') return '';
      var parsed = Date.parse(raw);
      if (!isNaN(parsed)) return formatTime(parsed);
      return raw;
    }

    function CategoryTab(props) {
      var state = props.state;
      var categories = toArray(props.categories);
      var selected = props.selectedCategory;
      var createOpenState = useState(false);
      var createOpen = createOpenState[0];
      var setCreateOpen = createOpenState[1];
      var createValueState = useState('');
      var createValue = createValueState[0];
      var setCreateValue = createValueState[1];
      var editingState = useState(null);
      var editingId = editingState[0];
      var setEditingId = editingState[1];
      var editValueState = useState('');
      var editValue = editValueState[0];
      var setEditValue = editValueState[1];
      var rulesIdState = useState(null);
      var rulesId = rulesIdState[0];
      var setRulesId = rulesIdState[1];
      var rulesValueState = useState('');
      var rulesValue = rulesValueState[0];
      var setRulesValue = rulesValueState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var organizingState = useState(false);
      var organizing = organizingState[0];
      var setOrganizing = organizingState[1];
      var errorState = useState('');
      var errorText = errorState[0];
      var setErrorText = errorState[1];

      var skills = toArray(state && state.skills).filter(function (skill) {
        return skill && selected && skill.category === selected.id;
      });
      var filtered = sortSkillList(filterSkillList(skills, props.query), 'name');
      var pageHook = useState(1);
      var page = pageHook[0];
      var setPage = pageHook[1];
      useEffect(function () { setPage(1); }, [selected ? selected.id : '', props.query]);
      var paged = paginate(filtered, page);

      function duplicateName(name, ignoreId) {
        for (var i = 0; i < categories.length; i += 1) {
          var item = categories[i];
          if (!item) continue;
          if (item.id === ignoreId) continue;
          if (str(item.name) === name) return true;
        }
        return false;
      }

      function submitCreate() {
        var name = createValue.trim();
        if (name === '') {
          setErrorText('分类名称不能为空');
          return;
        }
        if (duplicateName(name, null)) {
          setErrorText('已存在同名分类');
          return;
        }
        setBusy(true);
        setErrorText('');
        createCategory(name).then(function () {
          setBusy(false);
          setCreateOpen(false);
          setCreateValue('');
        }, function (createError) {
          setBusy(false);
          setErrorText((createError && createError.message) || '新增分类失败');
          failToast(createError);
        });
      }

      function startRename(category) {
        if (!category || category.builtin === true) return;
        setEditingId(category.id);
        setEditValue(str(category.name));
        setErrorText('');
      }

      function submitRename(category) {
        var name = editValue.trim();
        if (name === '') {
          setErrorText('分类名称不能为空');
          return;
        }
        if (duplicateName(name, category.id)) {
          setErrorText('已存在同名分类');
          return;
        }
        if (name === str(category.name)) {
          setEditingId(null);
          return;
        }
        setBusy(true);
        setErrorText('');
        renameCategory(category.id, name).then(function () {
          setBusy(false);
          setEditingId(null);
        }, function (renameError) {
          setBusy(false);
          setErrorText((renameError && renameError.message) || '重命名失败');
          failToast(renameError);
        });
      }

      function handleKeyDown(event, submit) {
        if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
          event.preventDefault();
          submit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setCreateOpen(false);
          setEditingId(null);
          setErrorText('');
        }
      }

      return h('div', { className: 'sm-split' },
        h('div', { className: 'sm-side' },
          h('div', { className: 'sm-side-head' },
            h('span', null, '分类'),
            h('span', { className: 'sm-spacer' }),
            h('button', {
              type: 'button',
              className: 'sm-btn sm-btn-small',
              disabled: createOpen || busy || organizing,
              title: '读取本机已安装的技能，按主题自动生成分类',
              onClick: function () {
                setOrganizing(true);
                setErrorText('');
                organizeCategoriesNow().catch(function (error) {
                  setErrorText((error && error.message) || '自动整理失败');
                }).then(function () { setOrganizing(false); });
              }
            }, organizing ? '整理中…' : '自动整理'),
            h('button', {
              type: 'button',
              className: 'sm-btn sm-btn-small',
              disabled: createOpen || busy || organizing,
              onClick: function () {
                setCreateOpen(true);
                setCreateValue('');
                setEditingId(null);
                setErrorText('');
              }
            }, '+ 新增分类')
          ),
          errorText ? h('div', { style: { padding: '8px 12px' } }, h('div', { className: 'sm-error-text' }, errorText)) : null,
          h('div', { className: 'sm-side-list' },
            createOpen
              ? h('div', { className: 'sm-inline-edit' },
                h('input', {
                  className: 'sm-input',
                  autoFocus: true,
                  value: createValue,
                  placeholder: '新分类名称',
                  disabled: busy,
                  onKeyDown: function (event) { handleKeyDown(event, submitCreate); },
                  onChange: function (event) { setCreateValue(event.target.value); }
                }),
                h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-primary', disabled: busy, onClick: submitCreate }, busy ? '保存中…' : '保存'),
                h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-ghost', disabled: busy, onClick: function () { setCreateOpen(false); setCreateValue(''); } }, '取消')
              )
              : null,
            categories.map(function (category) {
              if (!category) return null;
              var active = selected && selected.id === category.id;
              if (editingId === category.id) {
                return h('div', { key: category.id, className: 'sm-inline-edit' },
                  h('input', {
                    className: 'sm-input',
                    autoFocus: true,
                    value: editValue,
                    disabled: busy,
                    onKeyDown: function (event) { handleKeyDown(event, function () { submitRename(category); }); },
                    onChange: function (event) { setEditValue(event.target.value); }
                  }),
                  h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-primary', disabled: busy, onClick: function () { submitRename(category); } }, busy ? '保存中…' : '保存'),
                  h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-ghost', disabled: busy, onClick: function () { setEditingId(null); } }, '取消')
                );
              }
              if (rulesId === category.id) {
                function saveRules() {
                  var keywords = rulesValue.split(/[,，\s]+/).map(function (item) { return item.trim(); }).filter(Boolean);
                  setBusy(true);
                  setErrorText('');
                  props.onUpdateRules(category.id, keywords).catch(function (err) {
                    setErrorText((err && err.message) || '保存失败');
                  }).then(function () {
                    setBusy(false);
                    setRulesId(null);
                  });
                }
                return h('div', { key: category.id, className: 'sm-inline-edit sm-inline-edit-col' },
                  h('div', { className: 'sm-inline-edit-title' }, '「' + str(category.name) + '」识别关键词（逗号分隔，命中即归入该分类）'),
                  h('input', {
                    className: 'sm-input',
                    autoFocus: true,
                    value: rulesValue,
                    disabled: busy,
                    placeholder: '如：视频, 剪辑, ffmpeg',
                    onChange: function (event) { setRulesValue(event.target.value); },
                    onKeyDown: function (event) { handleKeyDown(event, saveRules); }
                  }),
                  h('div', { className: 'sm-inline-edit-actions' },
                    h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-primary', disabled: busy, onClick: saveRules }, busy ? '保存中…' : '保存'),
                    h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-ghost', disabled: busy, onClick: function () { setRulesId(null); } }, '取消')
                  )
                );
              }
              return h('div', {
                key: category.id,
                className: 'sm-cat-row',
                'data-active': active ? 'true' : 'false'
              },
                h('button', {
                  type: 'button',
                  className: 'sm-cat-main',
                  onClick: function () { props.onSelectCategory(category.id); }
                },
                  h('span', { className: 'sm-cat-name' }, str(category.name)),
                  h('span', { className: 'sm-cat-count' }, (Number(category.count) || 0) + ' 个')
                ),
                h('span', { className: 'sm-cat-meta' },
                  category.auto === true ? h(Badge, null, '自动') : null,
                  category.builtin === true ? h(Badge, { tone: 'idle' }, '内置') : null
                ),
                h('span', { className: 'sm-cat-actions' },
                  category.id === 'default'
                    ? null
                    : h('button', {
                      type: 'button',
                      className: 'sm-btn sm-btn-small sm-btn-ghost',
                      title: '编辑自动归类关键词',
                      onClick: function () {
                        setRulesId(category.id);
                        setRulesValue(toArray(category.keywords).join(', '));
                      }
                    }, '规则'),
                  category.builtin === true
                    ? null
                    : h(React.Fragment, null,
                      h('button', {
                        type: 'button',
                        className: 'sm-btn sm-btn-small sm-btn-ghost',
                        title: '重命名',
                        onClick: function () { startRename(category); }
                      }, '重命名'),
                      h('button', {
                        type: 'button',
                        className: 'sm-btn sm-btn-small sm-btn-ghost sm-error-text',
                        title: '删除分类',
                        onClick: function () { props.onDeleteCategory(category.id); }
                      }, '删除')
                    )
                )
              );
            })
          )
        ),
        h('div', { className: 'sm-main-col' },
          h('div', { className: 'sm-main-head' },
            h('span', { className: 'sm-main-title' },
              selected ? str(selected.name) + ' · ' + (Number(selected.count) || 0) + ' 个技能' : '全部分类'
            ),
            filtered.length !== skills.length
              ? h('span', { className: 'sm-main-count' }, '筛选出 ' + filtered.length + ' 个')
              : null
          ),
          h('div', { className: 'sm-list' },
            filtered.length === 0
              ? h(EmptyState, {
                title: '这个分类下还没有技能',
                description: skills.length === 0 ? '可从本地技能库移动进来。' : null
              })
              : paged.items.map(function (skill) {
                return h(SkillRow, {
                  key: skill.key,
                  skill: skill,
                  state: state,
                  readonlyLib: isReadonlySkill(state, skill),
                  moveLabel: '移动到分类…',
                  onOpen: props.onOpenDetail,
                  onCopy: props.onCopy,
                  onMove: props.onMove,
                  onDelete: props.onDelete
                });
              })
          ),
          filtered.length === 0 ? null : h(Pager, { total: filtered.length, page: paged.page, onPage: setPage })
        )
      );
    }

    // ── Tab 3：新增技能（仓库识别 / 保存 / 安装） ───────────────────────────
    function RepoTab(props) {
      var state = props.state;
      var urlState = useState('');
      var url = urlState[0];
      var setUrl = urlState[1];
      var recognizingState = useState(false);
      var recognizing = recognizingState[0];
      var setRecognizing = recognizingState[1];
      var resultState = useState(null);
      var resultRepo = resultState[0];
      var setResultRepo = resultState[1];
      var recognizeErrorState = useState(null);
      var recognizeError = recognizeErrorState[0];
      var setRecognizeError = recognizeErrorState[1];
      var selectedState = useState({});
      var selectedPaths = selectedState[0];
      var setSelectedPaths = selectedState[1];
      var savingState = useState(false);
      var saving = savingState[0];
      var setSaving = savingState[1];
      var expandedState = useState({});
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];
      var installStatesHook = useState({});
      var installStates = installStatesHook[0];
      var setInstallStates = installStatesHook[1];
      var progressState = useState(null);
      var installProgress = progressState[0];
      var setInstallProgress = progressState[1];
      var busyRepoState = useState(null);
      var busyRepo = busyRepoState[0];
      var setBusyRepo = busyRepoState[1];
      var dialogState = useState(null);
      var dialog = dialogState[0];
      var setDialog = dialogState[1];

      var repos = toArray(state && state.repos);
      var installs = (state && state.installs) || {};
      var targetLibraries = writableLibraries(state);
      var readonlyLibraries = toArray(state && state.libraries).filter(function (lib) {
        return lib && lib.writable === false;
      });

      function defaultTargetLib() {
        var preferred = findLibrary(targetLibraries, 'dsh');
        if (preferred) return preferred.key;
        return targetLibraries.length > 0 ? targetLibraries[0].key : '';
      }

      function patchInstallState(key, patch) {
        setInstallStates(function (prev) {
          var next = Object.assign({}, prev);
          next[key] = Object.assign({}, prev[key] || {}, patch);
          return next;
        });
      }

      function installKey(repoId, skillPath) {
        return str(repoId) + '::' + str(skillPath);
      }

      function handleRecognize() {
        var target = url.trim();
        if (target === '') {
          setRecognizeError({ message: '请先填写仓库地址' });
          return;
        }
        setRecognizing(true);
        setRecognizeError(null);
        setResultRepo(null);
        recognizeRepo(target).then(function (response) {
          var repo = response && response.repo ? response.repo : null;
          if (!repo) {
            setRecognizeError({ message: '识别结果为空，请确认仓库地址' });
            return;
          }
          setResultRepo(repo);
          var selection = {};
          toArray(repo.skills).forEach(function (skill) {
            if (skill && skill.path) selection[skill.path] = true;
          });
          setSelectedPaths(selection);
        }, function (error) {
          setRecognizeError({
            message: (error && error.message) || '识别失败，请稍后重试',
            code: (error && error.code) || ''
          });
        }).then(function () {
          setRecognizing(false);
        });
      }

      function handleSaveRepo() {
        if (!resultRepo) return;
        setSaving(true);
        saveRepo(resultRepo.url || url.trim()).then(function () {
          setSaving(false);
          setResultRepo(null);
          setUrl('');
          setRecognizeError(null);
        }, function (error) {
          setSaving(false);
          failToast(error);
        });
      }

      function toggleSelected(skillPath) {
        setSelectedPaths(function (prev) {
          var next = Object.assign({}, prev);
          next[skillPath] = !prev[skillPath];
          return next;
        });
      }

      function allSelected(rep) {
        var list = toArray(rep && rep.skills);
        for (var i = 0; i < list.length; i += 1) {
          if (!list[i] || !selectedPaths[list[i].path]) return false;
        }
        return list.length > 0;
      }

      function installLabel(libKey) {
        var lib = findLibrary(state && state.libraries, libKey);
        return lib ? str(lib.label) : str(libKey);
      }

      function runInstall(repoId, paths, toLib, onConflict) {
        var total = paths.length;
        var completed = 0;
        var succeeded = 0;
        setInstallProgress({ repoId: repoId, done: 0, total: total });
        var chain = Promise.resolve();
        paths.forEach(function (skillPath) {
          chain = chain.then(function () {
            var key = installKey(repoId, skillPath);
            patchInstallState(key, { status: 'running', message: '安装中…' });
            var repoRows = (store.state && store.state.repoAliases) || {};
            var alias = str(repoRows[key]);
            return installRepoSkill(repoId, skillPath, toLib, onConflict, alias).then(function (response) {
              completed += 1;
              if (response && response.action === 'skipped') {
                patchInstallState(key, { status: 'skipped', message: '已跳过（已有同名技能）' });
              } else {
                succeeded += 1;
                var extra = response && response.renamed ? '（重命名为 ' + response.renamed + '）' : '';
                patchInstallState(key, { status: 'done', message: '已安装到 ' + installLabel(toLib) + extra });
              }
              setInstallProgress({ repoId: repoId, done: completed, total: total });
            }, function (error) {
              completed += 1;
              patchInstallState(key, { status: 'error', message: (error && error.message) || '安装失败' });
              setInstallProgress({ repoId: repoId, done: completed, total: total });
            });
          });
        });
        return chain.then(function () {
          setInstallProgress(null);
          if (succeeded > 0) {
            pushToast('已安装 ' + succeeded + ' 个技能到「' + installLabel(toLib) + '」');
          }
          refreshQuietly(true);
        });
      }

      function openInstallDialog(repo, paths) {
        if (!repo || paths.length === 0) return;
        setDialog({ type: 'install', repo: repo, paths: paths });
      }

      function closeDialog() {
        setDialog(null);
      }

      function confirmInstall(toLib, onConflict) {
        var pending = dialog;
        setDialog(null);
        if (!pending) return;
        runInstall(pending.repo.id, pending.paths, toLib, onConflict);
      }

      function toggleRepoExpanded(repoId) {
        setExpanded(function (prev) {
          var next = Object.assign({}, prev);
          next[repoId] = !prev[repoId];
          return next;
        });
      }

      function handleRefreshRepo(repo) {
        setBusyRepo(repo.id);
        refreshRepo(repo.id).then(function () {
          setBusyRepo(null);
          pushToast('已刷新仓库「' + str(repo.owner) + '/' + str(repo.repo) + '」');
        }, function (error) {
          setBusyRepo(null);
          failToast(error);
        });
      }

      function handleDeleteRepo(repo) {
        setDialog({ type: 'delete-repo', repo: repo });
      }

      function confirmDeleteRepo() {
        var pending = dialog;
        setDialog(null);
        if (!pending) return;
        deleteRepo(pending.repo.id).then(function () {
          setBusyRepo(null);
        }, function (error) {
          failToast(error);
        });
      }

      function installAllOf(repo) {
        var paths = toArray(repo.skills).filter(function (skill) { return skill && skill.path; }).map(function (skill) {
          return skill.path;
        });
        openInstallDialog(repo, paths);
      }

      function installedInfo(repoId, skillPath) {
        var record = installs[installKey(repoId, skillPath)];
        if (!record) return null;
        return record;
      }

      function renderRepoSkill(repo, skill, options) {
        var key = installKey(repo.id, skill.path);
        var localState = installStates[key];
        var installed = installedInfo(repo.id, skill.path);
        var statusText = '';
        var statusTone = null;
        if (localState && localState.status === 'running') {
          statusText = '安装中…';
        } else if (localState && localState.status === 'error') {
          statusText = localState.message || '安装失败';
          statusTone = 'error';
        } else if (localState && localState.status === 'skipped') {
          statusText = '已跳过';
        } else if (installed) {
          statusText = '已安装（' + installLabel(installed.lib) + '）';
          statusTone = 'success';
        }
        var showCheckbox = options && options.checkbox === true;
        return h('div', { key: key, className: 'sm-table-row' },
          showCheckbox
            ? h('input', {
              type: 'checkbox',
              className: 'sm-check',
              checked: selectedPaths[skill.path] === true,
              'aria-label': '选择技能 ' + str(skill.name),
              onChange: function () { toggleSelected(skill.path); }
            })
            : null,
          h('span', { className: 'sm-repo-skill-name', title: str(skill.name) },
            str(skill.displayName) !== '' ? str(skill.displayName) : str(skill.name),
            str(skill.displayName) !== '' ? h('span', { className: 'sm-repo-skill-name-en' }, '（' + str(skill.name) + '）') : null),
          h('span', { className: 'sm-repo-skill-alias' },
            h('input', {
              className: 'sm-input sm-input-mini',
              defaultValue: str(skill.displayName),
              placeholder: '中文名（可选）',
              title: '给这个技能起中文名；安装后在各列表显示，可随时修改',
              onKeyDown: function (event) {
                if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
              },
              onBlur: function (event) {
                var next = event.target.value.trim();
                if (next === str(skill.displayName)) return;
                setRepoAlias(repo.id, skill.path, next).catch(failToast);
              }
            })
          ),
          h('span', { className: 'sm-repo-skill-desc', title: str(skill.description) }, str(skill.description) || '（暂无简介）'),
          h('span', { className: 'sm-repo-skill-path', title: str(skill.path) }, '路径 ' + str(skill.path)),
          statusText
            ? h('span', { className: statusTone === 'error' ? 'sm-error-text' : (statusTone === 'success' ? 'sm-success-text' : 'sm-hint') }, statusText)
            : null,
          h('button', {
            type: 'button',
            className: 'sm-btn sm-btn-small',
            disabled: busyRepo === repo.id,
            onClick: function () { openInstallDialog(repo, [skill.path]); }
          }, installed ? '重新安装' : '安装')
        );
      }

      function renderRecognizedCard(repo) {
        var skills = toArray(repo.skills);
        var visible = skills.filter(function (skill) {
          if (!skill) return false;
          var q = str(props.query).trim().toLowerCase();
          if (q === '') return true;
          return (str(skill.name) + '\n' + str(skill.description) + '\n' + str(skill.path)).toLowerCase().indexOf(q) !== -1;
        });
        var selectedCount = skills.filter(function (skill) { return skill && selectedPaths[skill.path]; }).length;
        return h('div', { className: 'sm-card' },
          h('div', { className: 'sm-card-head' },
            h('span', { className: 'sm-main-title' }, '✓ 已识别 ' + str(repo.owner) + '/' + str(repo.repo)),
            repo.stars ? h(Badge, null, '★ ' + formatStars(repo.stars)) : null,
            repo.ref ? h(Badge, null, '分支 ' + str(repo.ref)) : null,
            h('span', { className: 'sm-card-sub' }, skills.length + ' 个技能'),
            h('div', { className: 'sm-card-actions' },
              h('button', {
                type: 'button',
                className: 'sm-btn sm-btn-primary',
                disabled: saving,
                onClick: handleSaveRepo
              }, saving ? h(React.Fragment, null, h(Spinner), ' 保存中…') : '保存仓库'),
              h('button', {
                type: 'button',
                className: 'sm-btn sm-btn-ghost',
                disabled: saving,
                onClick: function () { setResultRepo(null); }
              }, '取消')
            )
          ),
          h('div', { className: 'sm-hint sm-mono', style: { marginTop: '4px' } }, str(repo.url)),
          h('div', { className: 'sm-table' }, visible.length === 0
            ? h('div', { className: 'sm-hint', style: { padding: '12px 4px' } }, '没有匹配的技能')
            : visible.map(function (skill) {
              return renderRepoSkill(repo, skill, { checkbox: true });
            })
          ),
          h('div', { className: 'sm-card-head', style: { marginTop: '10px' } },
            h('span', { className: 'sm-card-sub' }, '已选 ' + selectedCount + ' / ' + skills.length),
            h('div', { className: 'sm-card-actions' },
              h('button', {
                type: 'button',
                className: 'sm-btn sm-btn-primary',
                disabled: selectedCount === 0,
                onClick: function () {
                  var paths = skills.filter(function (skill) {
                    return skill && selectedPaths[skill.path];
                  }).map(function (skill) { return skill.path; });
                  openInstallDialog(repo, paths);
                }
              }, '安装选中 ' + selectedCount + ' 个')
            )
          )
        );
      }

      function renderSavedRepo(repo) {
        if (!repo) return null;
        var skills = toArray(repo.skills);
        var isExpanded = expanded[repo.id] === true;
        var filteredSkills = skills.filter(function (skill) {
          if (!skill) return false;
          var q = str(props.query).trim().toLowerCase();
          if (q === '') return true;
          return (str(skill.name) + '\n' + str(skill.description) + '\n' + str(skill.path)).toLowerCase().indexOf(q) !== -1;
        });
        var progress = installProgress && installProgress.repoId === repo.id ? installProgress : null;
        var installing = progress !== null;
        return h('div', { key: repo.id, className: 'sm-card' },
          h('div', { className: 'sm-card-head' },
            h('button', {
              type: 'button',
              className: 'sm-icon-btn',
              'aria-label': isExpanded ? '收起' : '展开',
              title: isExpanded ? '收起' : '展开',
              onClick: function () { toggleRepoExpanded(repo.id); }
            }, h(IconChevron, { open: isExpanded, size: 12 })),
            h('span', { className: 'sm-card-title' }, str(repo.owner) + '/' + str(repo.repo)),
            repo.stars ? h(Badge, null, '★ ' + formatStars(repo.stars)) : null,
            h('span', { className: 'sm-card-sub' }, skills.length + ' 个技能'),
            h('span', { className: 'sm-card-sub' }, '上次识别 ' + (formatWhen(repo.recognizedAt) || '—')),
            h('div', { className: 'sm-card-actions' },
              h('button', {
                type: 'button',
                className: 'sm-btn sm-btn-small sm-btn-primary',
                disabled: installing || busyRepo === repo.id,
                onClick: function () { installAllOf(repo); }
              }, '安装全部'),
              h('button', {
                type: 'button',
                className: 'sm-btn sm-btn-small',
                disabled: installing || busyRepo === repo.id,
                onClick: function () { handleRefreshRepo(repo); }
              }, busyRepo === repo.id ? h(React.Fragment, null, h(Spinner), ' 刷新中…') : '刷新'),
              h('button', {
                type: 'button',
                className: 'sm-btn sm-btn-small sm-btn-danger',
                disabled: installing,
                onClick: function () { handleDeleteRepo(repo); }
              }, '删除仓库')
            )
          ),
          progress
            ? h('div', null,
              h('div', { className: 'sm-progress' },
                h('div', {
                  className: 'sm-progress-bar',
                  style: { width: (progress.total > 0 ? Math.round(progress.done * 100 / progress.total) : 0) + '%' }
                })
              ),
              h('div', { className: 'sm-hint', style: { marginTop: '4px' } },
                '安装进度 ' + progress.done + ' / ' + progress.total +
                (busyRepo === repo.id ? ' · 正在刷新…' : '')
              )
            )
            : null,
          isExpanded
            ? h('div', { className: 'sm-table' }, filteredSkills.length === 0
              ? h('div', { className: 'sm-hint', style: { padding: '12px 4px' } }, '没有匹配的技能')
              : filteredSkills.map(function (skill) {
                return renderRepoSkill(repo, skill, { checkbox: false });
              })
            )
            : null
        );
      }

      var dialogNode = null;
      if (dialog && dialog.type === 'install') {
        dialogNode = h(InstallTargetDialog, {
          title: '安装技能到…',
          libraries: targetLibraries,
          readonlyLibraries: readonlyLibraries,
          defaultLibKey: defaultTargetLib(),
          skillLabel: dialog.paths.length === 1 ? str(dialog.paths[0]) : (dialog.paths.length + ' 个技能'),
          onCancel: closeDialog,
          onConfirm: confirmInstall
        });
      } else if (dialog && dialog.type === 'delete-repo') {
        dialogNode = h(ModalShell, {
          title: '删除仓库',
          onClose: closeDialog,
          footer: [
            h('button', { key: 'cancel', type: 'button', className: 'sm-btn', autoFocus: true, onClick: closeDialog }, '取消'),
            h('button', { key: 'confirm', type: 'button', className: 'sm-btn sm-btn-danger', onClick: confirmDeleteRepo }, '删除仓库')
          ]
        },
          h('div', null, '确认从列表移除仓库「' + str(dialog.repo.owner) + '/' + str(dialog.repo.repo) + '」？'),
          h('div', { className: 'sm-hint' }, '只删除保存的仓库记录，不会删除已经安装的技能。')
        );
      }

      return h('div', { className: 'sm-page' },
        h('div', { className: 'sm-page-inner' },
          h('div', { className: 'sm-card' },
            h('div', { className: 'sm-card-title' }, '按仓库地址新增技能'),
            h('div', { className: 'sm-row-input', style: { marginTop: '8px' } },
              h('input', {
                className: 'sm-input',
                value: url,
                placeholder: 'https://github.com/owner/repo',
                disabled: recognizing,
                'aria-label': '仓库地址',
                onChange: function (event) { setUrl(event.target.value); },
                onKeyDown: function (event) {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleRecognize();
                  }
                }
              }),
              h('button', {
                type: 'button',
                className: 'sm-btn sm-btn-primary',
                disabled: recognizing || url.trim() === '',
                onClick: handleRecognize
              }, recognizing ? h(React.Fragment, null, h(Spinner), ' 识别中…') : '识别')
            ),
            h('div', { className: 'sm-hint', style: { marginTop: '6px' } },
              '支持 GitHub 仓库根目录、子目录（/tree/main/skills）、.git 后缀与 git 地址。识别只读，不写盘。'
            ),
            recognizeError
              ? h('div', { style: { marginTop: '10px' } },
                h('div', { className: 'sm-error-box' },
                  h('span', null, str(recognizeError.message) || '识别失败'),
                  h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-danger', onClick: handleRecognize }, '重试')
                ),
                h('div', { className: 'sm-hint', style: { marginTop: '6px' } },
                  '常见原因：不是有效仓库 / 私有仓库 / 未找到 SKILL.md / 网络或频率限制。'
                )
              )
              : null
          ),
          resultRepo ? renderRecognizedCard(resultRepo) : null,
          h('div', { className: 'sm-card-head' },
            h('span', { className: 'sm-main-title' }, '已保存仓库（' + repos.length + '）'),
            h('span', { className: 'sm-hint' }, '展开后可按技能单独安装')
          ),
          repos.length === 0
            ? h(EmptyState, {
              title: '还没有保存的仓库',
              description: '识别成功后点「保存仓库」，之后可随时安装。'
            })
            : repos.map(function (repo) { return renderSavedRepo(repo); })
        ),
        dialogNode
      );
    }

    // ── 弹窗：复制到其它库 ──────────────────────────────────────────────────
    function CopyDialog(props) {
      var skill = props.skill;
      var libraries = writableLibraries(props.state).filter(function (lib) {
        return lib.key !== skill.lib;
      });
      var targetState = useState(libraries.length > 0 ? libraries[0].key : '');
      var targetLib = targetState[0];
      var setTargetLib = targetState[1];
      var conflictState = useState('skip');
      var conflict = conflictState[0];
      var setConflict = conflictState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = useState('');
      var errorText = errorState[0];
      var setErrorText = errorState[1];

      var targetMeta = findLibrary(libraries, targetLib);
      var targetDir = targetMeta
        ? str(targetMeta.displayDir) + '\\' + str(skill.relPath)
        : '';

      function submit() {
        if (!targetLib) {
          setErrorText('没有可写入的目标库');
          return;
        }
        setBusy(true);
        setErrorText('');
        copySkill(skill, targetLib, conflict).then(function () {
          setBusy(false);
          props.onClose();
        }, function (error) {
          setBusy(false);
          setErrorText((error && error.message) || '复制失败');
          failToast(error);
        });
      }

      return h(ModalShell, {
        title: '复制到其它技能库',
        onClose: busy ? function () {} : props.onClose,
        footer: [
          h('button', { key: 'cancel', type: 'button', className: 'sm-btn', autoFocus: true, disabled: busy, onClick: props.onClose }, '取消'),
          h('button', { key: 'confirm', type: 'button', className: 'sm-btn sm-btn-primary', disabled: busy || !targetLib, onClick: submit }, busy ? '复制中…' : '开始复制')
        ]
      },
        h('div', { className: 'sm-field' },
          h('span', { className: 'sm-field-label' }, '技能'),
          h('span', { className: 'sm-mono' }, str(skill.name) + '（' + (str(skill.libLabel) || str(skill.lib)) + '）')
        ),
        h('div', { className: 'sm-field' },
          h('span', { className: 'sm-field-label' }, '目标库'),
          libraries.length === 0
            ? h('div', { className: 'sm-warn-box' }, '没有可写入的目标库，请先在设置中启用其它技能库。')
            : h('select', {
              className: 'sm-select',
              value: targetLib,
              disabled: busy,
              'aria-label': '目标库',
              onChange: function (event) { setTargetLib(event.target.value); }
            }, libraries.map(function (lib) {
              return h('option', { key: lib.key, value: lib.key }, str(lib.label) + (lib.writable === false ? '（只读）' : ''));
            }))
        ),
        targetDir
          ? h('div', { className: 'sm-field' },
            h('span', { className: 'sm-field-label' }, '目标路径'),
            h('span', { className: 'sm-mono' }, targetDir)
          )
          : null,
        h('div', { className: 'sm-field' },
          h('span', { className: 'sm-field-label' }, '同名冲突'),
          h('div', { className: 'sm-radio-row' }, CONFLICT_OPTIONS.map(function (option) {
            return h('label', {
              key: option.value,
              className: 'sm-radio-option',
              'data-active': conflict === option.value ? 'true' : 'false',
              title: option.hint
            },
              h('input', {
                type: 'radio',
                name: 'sm-copy-conflict',
                value: option.value,
                checked: conflict === option.value,
                disabled: busy,
                onChange: function () { setConflict(option.value); }
              }),
              option.label
            );
          }))
        ),
        errorText ? h('div', { className: 'sm-error-text' }, errorText) : null
      );
    }

    // ── 弹窗：移动到分类 ────────────────────────────────────────────────────
    function MoveDialog(props) {
      var skill = props.skill;
      var categories = toArray(props.state && props.state.categories);
      var initial = skill.categoryManual === true ? str(skill.category) : '';
      var targetState = useState(initial);
      var target = targetState[0];
      var setTarget = targetState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = useState('');
      var errorText = errorState[0];
      var setErrorText = errorState[1];

      function submit() {
        setBusy(true);
        setErrorText('');
        assignCategory(skill, target === '' ? null : target).then(function () {
          setBusy(false);
          props.onClose();
        }, function (error) {
          setBusy(false);
          setErrorText((error && error.message) || '归类失败');
          failToast(error);
        });
      }

      return h(ModalShell, {
        title: '移动到分类',
        onClose: busy ? function () {} : props.onClose,
        footer: [
          h('button', { key: 'cancel', type: 'button', className: 'sm-btn', autoFocus: true, disabled: busy, onClick: props.onClose }, '取消'),
          h('button', { key: 'confirm', type: 'button', className: 'sm-btn sm-btn-primary', disabled: busy, onClick: submit }, busy ? '保存中…' : '保存')
        ]
      },
        h('div', { className: 'sm-field' },
          h('span', { className: 'sm-field-label' }, '技能'),
          h('span', { className: 'sm-mono' }, str(skill.name))
        ),
        h('div', { className: 'sm-field' },
          h('span', { className: 'sm-field-label' }, '目标分类'),
          h('select', {
            className: 'sm-select',
            value: target,
            disabled: busy,
            'aria-label': '目标分类',
            onChange: function (event) { setTarget(event.target.value); }
          },
            h('option', { value: '' }, '自动归类（按规则）'),
            categories.map(function (category) {
              return h('option', { key: category.id, value: category.id }, str(category.name));
            })
          )
        ),
        h('div', { className: 'sm-hint' }, '手动指定的分类优先于自动归类规则。'),
        errorText ? h('div', { className: 'sm-error-text' }, errorText) : null
      );
    }

    // ── 弹窗：删除技能（危险确认） ──────────────────────────────────────────
    function DeleteDialog(props) {
      var skill = props.skill;
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = useState('');
      var errorText = errorState[0];
      var setErrorText = errorState[1];

      function submit() {
        setBusy(true);
        setErrorText('');
        deleteSkill(skill).then(function () {
          setBusy(false);
          props.onClose();
        }, function (error) {
          setBusy(false);
          setErrorText((error && error.message) || '删除失败');
          failToast(error);
        });
      }

      return h(ModalShell, {
        title: '删除技能',
        onClose: busy ? function () {} : props.onClose,
        footer: [
          h('button', { key: 'cancel', type: 'button', className: 'sm-btn', autoFocus: true, disabled: busy, onClick: props.onClose }, '取消'),
          h('button', { key: 'confirm', type: 'button', className: 'sm-btn sm-btn-danger', disabled: busy, onClick: submit }, busy ? '删除中…' : '确认删除')
        ]
      },
        h('div', null, '确认删除技能「', h('span', { className: 'sm-mono' }, str(skill.name)), '」？'),
        h('div', { className: 'sm-field' },
          h('span', { className: 'sm-field-label' }, '来源库'),
          h('span', null, str(skill.libLabel) || str(skill.lib))
        ),
        h('div', { className: 'sm-field' },
          h('span', { className: 'sm-field-label' }, '完整路径'),
          h('span', { className: 'sm-mono' }, str(skill.dir))
        ),
        h('div', { className: 'sm-warn-box' }, '技能会移入回收站，5 秒内可撤销，也可以在设置里恢复。'),
        errorText ? h('div', { className: 'sm-error-text' }, errorText) : null
      );
    }

    // ── 弹窗：删除分类 ──────────────────────────────────────────────────────
    function CategoryDeleteDialog(props) {
      var category = props.category;
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = useState('');
      var errorText = errorState[0];
      var setErrorText = errorState[1];

      function submit() {
        setBusy(true);
        setErrorText('');
        deleteCategory(category).then(function () {
          setBusy(false);
          props.onClose();
        }, function (error) {
          setBusy(false);
          setErrorText((error && error.message) || '删除分类失败');
          failToast(error);
        });
      }

      return h(ModalShell, {
        title: '删除分类',
        onClose: busy ? function () {} : props.onClose,
        footer: [
          h('button', { key: 'cancel', type: 'button', className: 'sm-btn', autoFocus: true, disabled: busy, onClick: props.onClose }, '取消'),
          h('button', { key: 'confirm', type: 'button', className: 'sm-btn sm-btn-danger', disabled: busy, onClick: submit }, busy ? '删除中…' : '确认删除')
        ]
      },
        h('div', null, '确认删除分类「' + str(category.name) + '」？'),
        h('div', { className: 'sm-warn-box' },
          '该分类下的 ' + (Number(category.count) || 0) + ' 个技能将移入「默认分类」，不会删除任何技能文件。'
        ),
        errorText ? h('div', { className: 'sm-error-text' }, errorText) : null
      );
    }

    // ── 弹窗：安装目标库与冲突策略 ──────────────────────────────────────────
    function InstallTargetDialog(props) {
      var libraries = toArray(props.libraries);
      var defaultKey = str(props.defaultLibKey);
      if (findLibrary(libraries, defaultKey) === null && libraries.length > 0) {
        defaultKey = libraries[0].key;
      }
      var targetState = useState(defaultKey);
      var targetLib = targetState[0];
      var setTargetLib = targetState[1];
      var conflictState = useState('skip');
      var conflict = conflictState[0];
      var setConflict = conflictState[1];

      var readonlyLibraries = toArray(props.readonlyLibraries);

      function submit() {
        if (!targetLib) return;
        if (typeof props.onConfirm === 'function') {
          props.onConfirm(targetLib, conflict);
        }
      }

      return h(ModalShell, {
        title: props.title || '安装到…',
        onClose: props.onCancel,
        footer: [
          h('button', { key: 'cancel', type: 'button', className: 'sm-btn', autoFocus: true, onClick: props.onCancel }, '取消'),
          h('button', { key: 'confirm', type: 'button', className: 'sm-btn sm-btn-primary', disabled: libraries.length === 0, onClick: submit }, '开始安装')
        ]
      },
        h('div', { className: 'sm-field' },
          h('span', { className: 'sm-field-label' }, '安装内容'),
          h('span', { className: 'sm-mono' }, str(props.skillLabel))
        ),
        h('div', { className: 'sm-field' },
          h('span', { className: 'sm-field-label' }, '目标库'),
          libraries.length === 0
            ? h('div', { className: 'sm-warn-box' }, '没有可写入的目标库，请先在设置中启用技能库。')
            : h('select', {
              className: 'sm-select',
              value: targetLib,
              'aria-label': '目标库',
              onChange: function (event) { setTargetLib(event.target.value); }
            }, libraries.map(function (lib) {
              return h('option', { key: lib.key, value: lib.key }, str(lib.label));
            }))
        ),
        readonlyLibraries.length > 0
          ? h('div', { className: 'sm-hint' }, '只读库不可作为安装目标：' + readonlyLibraries.map(function (lib) {
            return str(lib.label);
          }).join('、'))
          : null,
        h('div', { className: 'sm-field' },
          h('span', { className: 'sm-field-label' }, '同名冲突处理'),
          h('div', { className: 'sm-radio-row' }, CONFLICT_OPTIONS.map(function (option) {
            return h('label', {
              key: option.value,
              className: 'sm-radio-option',
              'data-active': conflict === option.value ? 'true' : 'false',
              title: option.hint
            },
              h('input', {
                type: 'radio',
                name: 'sm-install-conflict',
                value: option.value,
                checked: conflict === option.value,
                onChange: function () { setConflict(option.value); }
              }),
              option.label
            );
          }))
        ),
        h('div', { className: 'sm-hint' }, '安装只下载仓库中的技能文件，不执行仓库内脚本。')
      );
    }

    // ── 弹窗：设置 ──────────────────────────────────────────────────────────
    function SettingsDialog(props) {
      var state = props.state;
      var settings = (state && state.settings) || {};
      var libraries = toArray(state && state.libraries);
      var trash = toArray(state && state.trash);
      var autoTranslate = settings.autoTranslate === true;
      var provider = str(settings.translateProvider) || 'auto';
      var autoClassify = settings.autoClassify === true;
      var disabledLibraries = toArray(settings.disabledLibraries);
      var purgeState = useState(null);
      var confirmPurgeId = purgeState[0];
      var setConfirmPurgeId = purgeState[1];
      var errorState = useState('');
      var errorText = errorState[0];
      var setErrorText = errorState[1];

      function applySettings(patch) {
        setErrorText('');
        saveSettings(patch).catch(function (error) {
          setErrorText((error && error.message) || '保存设置失败');
          failToast(error);
        });
      }

      function libraryEnabled(lib) {
        return disabledLibraries.indexOf(lib.key) === -1;
      }

      function toggleLibrary(lib, nextEnabled) {
        var next = disabledLibraries.filter(function (key) { return key !== lib.key; });
        if (!nextEnabled) next.push(lib.key);
        applySettings({ disabledLibraries: next });
      }

      function handlePurge(item) {
        if (confirmPurgeId !== item.id) {
          setConfirmPurgeId(item.id);
          return;
        }
        setConfirmPurgeId(null);
        purgeTrash(item.id).catch(failToast);
      }

      var footer = h('button', { type: 'button', className: 'sm-btn', onClick: props.onClose }, '关闭');

      return h(ModalShell, { title: '技能管理设置', wide: true, onClose: props.onClose, footer: footer },
        errorText ? h('div', { className: 'sm-error-text' }, errorText) : null,
        h('div', { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, '翻译与归类'),
          h(FieldRow, {
            label: '自动翻译英文简介',
            hint: '后台逐条补充中文简介与适用场景，仅联网翻译。'
          }, h(Switch, {
            checked: autoTranslate,
            label: '自动翻译开关',
            onChange: function (next) { applySettings({ autoTranslate: next }); }
          })),
          h(FieldRow, {
            label: '翻译服务',
            hint: '自动模式先走 Google，失败回退 Bing。'
          }, h('select', {
            className: 'sm-select',
            value: provider,
            disabled: !autoTranslate,
            'aria-label': '翻译服务',
            onChange: function (event) { applySettings({ translateProvider: event.target.value }); }
          }, PROVIDER_OPTIONS.map(function (option) {
            return h('option', { key: option.value, value: option.value }, option.label);
          }))),
          h(FieldRow, {
            label: '自动归类',
            hint: '按分类关键词把新技能自动归入分类。'
          }, h(Switch, {
            checked: autoClassify,
            label: '自动归类开关',
            onChange: function (next) { applySettings({ autoClassify: next }); }
          }))
        ),
        h('div', { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, '技能库启用'),
          libraries.length === 0
            ? h('div', { className: 'sm-hint' }, '暂无已发现的技能库')
            : libraries.map(function (lib) {
              return h(FieldRow, {
                key: lib.key,
                label: str(lib.label) || str(lib.key),
                hint: (Number(lib.count) || 0) + ' 个技能 · ' + (str(lib.displayDir) || str(lib.dir))
              }, h(Switch, {
                checked: libraryEnabled(lib),
                label: '启用 ' + str(lib.label),
                onChange: function (next) { toggleLibrary(lib, next); }
              }));
            })
        ),
        h('div', { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, '回收站（' + trash.length + '）'),
          trash.length === 0
            ? h('div', { className: 'sm-hint' }, '回收站是空的。删除的技能会先放在这里，可随时恢复。')
            : trash.map(function (item) {
              return h('div', { key: item.id, className: 'sm-trash-row' },
                h('span', { className: 'sm-trash-name', title: str(item.originalPath) }, str(item.name)),
                h('span', { className: 'sm-trash-meta' }, formatWhen(item.at) + ' · ' + formatBytes(item.bytes)),
                confirmPurgeId === item.id
                  ? h(React.Fragment, null,
                    h('span', { className: 'sm-error-text' }, '彻底删除后不可恢复：'),
                    h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-danger', onClick: function () { handlePurge(item); } }, '确认彻底删除'),
                    h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-ghost', onClick: function () { setConfirmPurgeId(null); } }, '取消')
                  )
                  : h(React.Fragment, null,
                    h('button', {
                      type: 'button',
                      className: 'sm-btn sm-btn-small',
                      onClick: function () {
                        restoreTrash(item.id).catch(failToast);
                      }
                    }, '恢复'),
                    h('button', {
                      type: 'button',
                      className: 'sm-btn sm-btn-small sm-btn-danger',
                      onClick: function () { handlePurge(item); }
                    }, '彻底删除')
                  )
              );
            })
        ),
        h('div', { className: 'sm-card' },
          h('div', { className: 'sm-card-title' }, '数据文件'),
          h('div', { className: 'sm-hint' }, '插件数据保存在用户目录，不写入你的工程：'),
          h('div', { className: 'sm-mono', style: { marginTop: '4px' } }, '~\\.dsh\\skill-manager\\state.json')
        )
      );
    }

    // ── 技能详情抽屉 ────────────────────────────────────────────────────────
    function DetailDrawer(props) {
      var skill = props.skill;
      var state = props.state;
      var detailState = useState(null);
      var detail = detailState[0];
      var setDetail = detailState[1];
      var loadingState = useState(true);
      var loading = loadingState[0];
      var setLoading = loadingState[1];
      var errorState = useState('');
      var errorText = errorState[0];
      var setErrorText = errorState[1];
      var reloadState = useState(0);
      var reload = reloadState[0];
      var setReload = reloadState[1];
      var editingState = useState(null);
      var editing = editingState[0];
      var setEditing = editingState[1];
      var draftState = useState('');
      var draft = draftState[0];
      var setDraft = draftState[1];
      var savingState = useState(false);
      var saving = savingState[0];
      var setSaving = savingState[1];
      var showOriginalState = useState(false);
      var showOriginal = showOriginalState[0];
      var setShowOriginal = showOriginalState[1];
      var readonly = isReadonlySkill(state, skill);

      useEffect(function () {
        var cancelled = false;
        setLoading(true);
        setDetail(null);
        setErrorText('');
        api.get('/skill?lib=' + encodeURIComponent(str(skill.lib)) + '&path=' + encodeURIComponent(str(skill.relPath))).then(function (data) {
          if (cancelled) return;
          setDetail(data && typeof data === 'object' ? data : null);
          setLoading(false);
        }, function (error) {
          if (cancelled) return;
          setErrorText((error && error.message) || '加载技能详情失败');
          setLoading(false);
        });
        return function () {
          cancelled = true;
        };
      }, [skill.key, reload]);

      function startEdit(field) {
        setEditing(field);
        if (field === 'scene') setDraft(str(skill.scene));
        else if (field === 'alias') setDraft(str(skill.displayName));
        else setDraft(str(skill.descriptionZh));
      }

      function cancelEdit() {
        setEditing(null);
        setDraft('');
      }

      function saveEdit(field) {
        setSaving(true);
        if (field === 'alias') {
          setSkillAlias(skill.name, draft.trim()).then(function () {
            setSaving(false);
            setEditing(null);
          }, function (error) {
            setSaving(false);
            failToast(error);
          });
          return;
        }
        var patch = {};
        if (field === 'scene') {
          patch.scene = draft;
        } else {
          patch.descriptionZh = draft;
        }
        overrideSkill(skill, patch).then(function () {
          setSaving(false);
          setEditing(null);
        }, function (error) {
          setSaving(false);
          failToast(error);
        });
      }

      function handleCopyPath() {
        copyText(str(skill.dir)).then(function (ok) {
          pushToast(ok ? '已复制技能路径' : '复制失败，请手动复制', ok ? undefined : { kind: 'error' });
        });
      }

      var files = toArray(detail && detail.files);
      var visibleFiles = files.slice(0, 50);
      var frontmatter = (detail && detail.frontmatter) || {};

      function renderEditable(field, label, value) {
        if (editing === field) {
          return h('div', { className: 'sm-field' },
            h('span', { className: 'sm-field-label' }, label),
            h('textarea', {
              className: 'sm-textarea',
              autoFocus: true,
              value: draft,
              disabled: saving,
              onChange: function (event) { setDraft(event.target.value); }
            }),
            h('div', { style: { display: 'flex', gap: '6px' } },
              h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-primary', disabled: saving, onClick: function () { saveEdit(field); } }, saving ? '保存中…' : '保存'),
              h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-ghost', disabled: saving, onClick: cancelEdit }, '取消')
            )
          );
        }
        return h('div', { className: 'sm-field' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('span', { className: 'sm-field-label' }, label),
            readonly ? null : h('button', {
              type: 'button',
              className: 'sm-btn sm-btn-small sm-btn-ghost',
              onClick: function () { startEdit(field); }
            }, '编辑')
          ),
          h('div', { className: 'sm-field-value' }, value || '（未填写）')
        );
      }

      return h('div', { className: 'sm-drawer-overlay' },
        h('div', { className: 'sm-drawer-mask', onMouseDown: props.onClose }),
        h('div', { className: 'sm-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '技能详情' },
          h('div', { className: 'sm-drawer-head' },
            h('div', { className: 'sm-drawer-title' },
              h('div', { className: 'sm-skill-line1' },
                h('span', { className: 'sm-skill-name', title: str(skill.name) },
                  skillTitle(skill),
                  hasAlias(skill) ? h('span', { className: 'sm-skill-alias' }, '（' + str(skill.name) + '）') : null),
                h(Badge, { tone: 'brand' }, str(skill.libLabel) || str(skill.lib)),
                h(Badge, null, categoryName(state && state.categories, skill.category)),
                skill.invocable === false ? h(Badge, { tone: 'idle' }, '仅浏览') : null
              ),
              h('div', { className: 'sm-mono' }, str(skill.dir))
            ),
            h('button', { type: 'button', className: 'sm-icon-btn', 'aria-label': '关闭详情', onClick: props.onClose }, h(IconClose, { size: 14 }))
          ),
          h('div', { className: 'sm-drawer-body' },
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
              h('button', { type: 'button', className: 'sm-btn sm-btn-small', onClick: handleCopyPath }, '复制路径')
            ),
            errorText ? h(ErrorBox, { message: errorText, onRetry: function () { setReload(reload + 1); } }) : null,
            loading ? h('div', { className: 'sm-hint' }, '正在读取 SKILL.md…') : null,
            renderEditable('alias', '中文名称', str(skill.displayName)),
            renderEditable('zh', '中文简介', str(skill.descriptionZh)),
            renderEditable('scene', '适用场景', str(skill.scene)),
            h('div', { className: 'sm-field' },
              h('button', {
                type: 'button',
                className: 'sm-btn sm-btn-small sm-btn-ghost',
                onClick: function () { setShowOriginal(!showOriginal); }
              }, (showOriginal ? '▾ ' : '▸ ') + '英文原文'),
              showOriginal
                ? h('div', null,
                  h('div', { className: 'sm-field-label' }, 'description'),
                  h('div', { className: 'sm-field-value' }, str(frontmatter.description) || str(skill.description) || '（空）'),
                  frontmatter.whenToUse || skill.scene
                    ? h('div', null,
                      h('div', { className: 'sm-field-label', style: { marginTop: '6px' } }, 'whenToUse'),
                      h('div', { className: 'sm-field-value' }, str(frontmatter.whenToUse) || str(skill.scene))
                    )
                    : null,
                  detail && detail.content
                    ? h('div', null,
                      h('div', { className: 'sm-field-label', style: { marginTop: '6px' } }, 'SKILL.md 正文预览'),
                      h('pre', {
                        className: 'sm-mono',
                        style: { whiteSpace: 'pre-wrap', maxHeight: '220px', overflow: 'auto', margin: '4px 0 0', background: 'var(--dsw-alias-bg-base)', padding: '8px', borderRadius: '8px' }
                      }, str(detail.content).slice(0, 4000))
                    )
                    : null,
                  detail && detail.truncated ? h('div', { className: 'sm-hint' }, '正文超过 128KB，已截断显示。') : null
                )
                : null
            ),
            h('div', { className: 'sm-field' },
              h('span', { className: 'sm-field-label' }, '文件'),
              loading
                ? h('span', { className: 'sm-hint' }, '读取中…')
                : h('div', null,
                  h('div', { className: 'sm-hint' }, (Number(detail && detail.bytes) || 0) > 0 ? formatBytes(detail.bytes) + ' · ' + files.length + ' 个文件 · 修改于 ' + (formatWhen(detail && detail.mtime) || formatWhen(skill.mtime) || '未知') : '修改于 ' + (formatWhen(skill.mtime) || '未知')),
                  files.length > 0
                    ? h('div', { className: 'sm-file-list', style: { marginTop: '6px' } }, visibleFiles.map(function (file) {
                      return h('div', { key: str(file.path), className: 'sm-file-row' },
                        h('span', { className: 'sm-clip' }, str(file.path)),
                        h('span', { className: 'sm-file-size' }, formatBytes(file.size))
                      );
                    }))
                    : null,
                  files.length > 50
                    ? h('div', { className: 'sm-hint', style: { marginTop: '4px' } }, '仅显示前 50 个文件。')
                    : null
                )
            )
          ),
          h('div', { className: 'sm-drawer-foot' },
            readonly
              ? h('span', { className: 'sm-hint' }, '只读库的技能仅支持浏览与复制路径。')
              : h(React.Fragment, null,
                h('button', { type: 'button', className: 'sm-btn sm-btn-small', onClick: function () { props.onCopy(skill.key); } }, '复制到…'),
                h('button', { type: 'button', className: 'sm-btn sm-btn-small', onClick: function () { props.onMove(skill.key); } }, '移动到分类…'),
                h('button', { type: 'button', className: 'sm-btn sm-btn-small sm-btn-danger', onClick: function () { props.onDelete(skill.key); } }, '删除')
              )
          )
        )
      );
    }

    // ── 对话框技能选择器 ────────────────────────────────────────────────────
    function readRecent() {
      try {
        var raw = localStorage.getItem(RECENT_KEY);
        if (!raw) return [];
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(function (item) {
          return typeof item === 'string' && item !== '';
        }).slice(0, RECENT_MAX);
      } catch (error) {
        return [];
      }
    }

    function writeRecent(list) {
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
      } catch (error) {
        // localStorage 不可用时忽略最近使用
      }
    }

    function rememberSkill(name) {
      var value = str(name);
      if (value === '') return;
      var list = readRecent().filter(function (item) { return item !== value; });
      list.unshift(value);
      writeRecent(list);
    }

    function refocusComposer() {
      try {
        var card = document.querySelector('[data-composer-card]');
        var textarea = card ? card.querySelector('textarea') : null;
        if (textarea && typeof textarea.focus === 'function') textarea.focus();
      } catch (error) {
        // 输入框可能已卸载
      }
    }

    function getPortalHost() {
      try {
        if (typeof document === 'undefined') return null;
        var existing = document.querySelector('[data-skill-manager-portal]');
        if (existing) return existing;
        var host = document.createElement('div');
        host.setAttribute('data-skill-manager-portal', '');
        document.body.appendChild(host);
        return host;
      } catch (error) {
        return null;
      }
    }

    function SkillPicker(props) {
      useStyles();
      useStore();
      var queryState = useState('');
      var query = queryState[0];
      var setQuery = queryState[1];
      var collapsedState = useState({});
      var collapsed = collapsedState[0];
      var setCollapsed = collapsedState[1];
      var activeState = useState(0);
      var active = activeState[0];
      var setActive = activeState[1];
      var inputRef = useRef(null);
      var listRef = useRef(null);

      var state = store.state;
      var skills = invocableSkills(state);
      var categories = toArray(state && state.categories);
      var recent = readRecent();
      var q = query.trim().toLowerCase();

      function matches(skill) {
        if (q === '') return true;
        var haystack = [
          skill.name, skill.description, skill.descriptionZh, skill.scene, skill.category
        ].map(str).join('\n').toLowerCase();
        return haystack.indexOf(q) !== -1;
      }

      var groups = [];
      var recentSkills = [];
      recent.forEach(function (name) {
        for (var i = 0; i < skills.length; i += 1) {
          if (skills[i] && str(skills[i].name) === name) {
            recentSkills.push(skills[i]);
            return;
          }
        }
      });
      recentSkills = recentSkills.filter(matches).slice(0, RECENT_MAX);
      if (recentSkills.length > 0) {
        groups.push({ id: '__recent', label: '最近使用', skills: recentSkills, noCount: true });
      }
      categories.forEach(function (category) {
        if (!category) return;
        var groupSkills = skills.filter(function (skill) {
          return (str(skill.category) || DEFAULT_CATEGORY) === category.id && matches(skill);
        });
        if (groupSkills.length > 0) {
          groups.push({ id: str(category.id), label: str(category.name), skills: groupSkills, noCount: false });
        }
      });
      var knownCategoryIds = {};
      categories.forEach(function (category) {
        if (category) knownCategoryIds[str(category.id)] = true;
      });
      var straySkills = skills.filter(function (skill) {
        var categoryId = str(skill.category) || DEFAULT_CATEGORY;
        return !knownCategoryIds[categoryId] && matches(skill);
      });
      if (straySkills.length > 0) {
        groups.push({ id: '__other', label: '未分类', skills: straySkills, noCount: false });
      }

      function isGroupCollapsed(groupId) {
        if (q !== '') return false;
        return collapsed[groupId] === undefined ? groupId !== '__recent' : collapsed[groupId] === true;
      }

      var flatRows = [];
      groups.forEach(function (group) {
        if (isGroupCollapsed(group.id)) return;
        group.skills.forEach(function (skill) {
          flatRows.push(skill);
        });
      });

      useEffect(function () {
        try {
          if (inputRef.current) inputRef.current.focus();
        } catch (error) {
          // 忽略
        }
      }, []);

      useEffect(function () {
        setActive(0);
      }, [query]);

      useEffect(function () {
        function onDocumentKeyDown(event) {
          if (event.key !== 'Escape') return;
          if (event.nativeEvent && event.nativeEvent.isComposing === true) return;
          props.onClose();
        }
        if (typeof document !== 'undefined') document.addEventListener('keydown', onDocumentKeyDown);
        return function () {
          if (typeof document !== 'undefined') document.removeEventListener('keydown', onDocumentKeyDown);
        };
      }, []);

      useEffect(function () {
        var list = listRef.current;
        if (!list) return;
        var target = list.querySelector('[data-sm-picker-index="' + active + '"]');
        if (target && typeof target.scrollIntoView === 'function') {
          try {
            target.scrollIntoView({ block: 'nearest' });
          } catch (error) {
            // 忽略滚动异常
          }
        }
      }, [active, query, collapsed]);

      function toggleGroup(groupId) {
        setCollapsed(function (prev) {
          var next = Object.assign({}, prev);
          var current = prev[groupId] === undefined ? groupId !== '__recent' : prev[groupId] === true;
          next[groupId] = !current;
          return next;
        });
      }

      function handleKeyDown(event) {
        if (event.nativeEvent && event.nativeEvent.isComposing === true) return;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive(function (current) { return Math.min(current + 1, Math.max(0, flatRows.length - 1)); });
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive(function (current) { return Math.max(current - 1, 0); });
        } else if (event.key === 'Enter') {
          event.preventDefault();
          var row = flatRows[active];
          if (row) props.onPick(row);
        }
      }

      var anchor = props.anchor || { left: 16, top: 420 };
      var pickerWidth = 380;
      var winWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
      var winHeight = typeof window !== 'undefined' ? window.innerHeight : 768;
      var left = Math.max(8, Math.min(Number(anchor.left) || 8, winWidth - pickerWidth - 8));
      var bottom = Math.max(8, winHeight - (Number(anchor.top) || 420) + 6);

      var listNodes = [];
      groups.forEach(function (group) {
        var isCollapsed = isGroupCollapsed(group.id);
        listNodes.push(h('div', { key: 'group-' + group.id, className: 'sm-picker-group' },
          h('button', {
            type: 'button',
            className: 'sm-picker-group-head',
            'aria-expanded': !isCollapsed,
            onClick: function () { toggleGroup(group.id); }
          },
            h(IconChevron, { open: !isCollapsed, size: 11 }),
            h('span', { className: 'sm-picker-group-name' }, group.label),
            group.noCount ? null : h('span', null, '(' + group.skills.length + ')')
          ),
          isCollapsed ? null : group.skills.map(function (skill) {
            var index = -1;
            for (var i = 0; i < flatRows.length; i += 1) {
              if (flatRows[i] === skill) {
                index = i;
                break;
              }
            }
            return h('button', {
              key: 'skill-' + str(skill.key),
              type: 'button',
              className: 'sm-picker-row',
              'data-sm-picker-index': index,
              'data-active': index === active ? 'true' : 'false',
              role: 'option',
              'aria-selected': index === active,
              onMouseEnter: function () { if (index >= 0) setActive(index); },
              onMouseDown: function (event) { event.preventDefault(); props.onPick(skill); }
            },
              h('span', { className: 'sm-picker-name', title: str(skill.name) },
                skillTitle(skill),
                hasAlias(skill) ? h('span', { className: 'sm-picker-name-en' }, ' ' + str(skill.name)) : null),
              h('span', { className: 'sm-picker-desc' }, skillDescription(skill) || '（暂无简介）')
            );
          })
        ));
      });

      var body;
      if (skills.length === 0) {
        body = h('div', { className: 'sm-picker-empty' },
          state ? '先在工作台把外部技能复制到 DSH 用户库' : '正在加载技能…'
        );
      } else if (groups.length === 0) {
        body = h('div', { className: 'sm-picker-empty' }, '没有匹配的技能');
      } else {
        body = listNodes;
      }

      return h(React.Fragment, null,
        h('div', { className: 'sm-picker-backdrop', onMouseDown: function () { props.onClose(); } }),
        h('div', {
          className: 'sm-picker',
          role: 'dialog',
          'aria-label': '选择技能',
          style: { left: left + 'px', bottom: bottom + 'px' },
          onKeyDown: handleKeyDown
        },
          h('div', { className: 'sm-picker-search' },
            h('input', {
              ref: inputRef,
              className: 'sm-input',
              type: 'search',
              value: query,
              placeholder: '搜索技能…',
              'aria-label': '搜索技能',
              onChange: function (event) { setQuery(event.target.value); }
            })
          ),
          h('div', { className: 'sm-picker-list', ref: listRef, role: 'listbox' }, body),
          h('div', { className: 'sm-picker-foot' },
            h('span', { className: 'sm-kbd' }, '↑'),
            h('span', { className: 'sm-kbd' }, '↓'),
            h('span', null, '选择'),
            h('span', { className: 'sm-kbd' }, 'Enter'),
            h('span', null, '插入'),
            h('span', { className: 'sm-kbd' }, 'Esc'),
            h('span', null, '关闭'),
            h('span', { className: 'sm-spacer' }),
            h('span', null, '外部技能需先复制到 DSH 用户库')
          )
        )
      );
    }

    function ComposerSkillButton(props) {
      useStyles();
      useStore();
      var openState = useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var anchorState = useState(null);
      var anchor = anchorState[0];
      var setAnchor = anchorState[1];
      var buttonRef = useRef(null);
      var inputActions = props ? props.inputActions : null;

      function openPicker() {
        var rect = null;
        try {
          if (buttonRef.current) rect = buttonRef.current.getBoundingClientRect();
        } catch (error) {
          rect = null;
        }
        if (!rect) rect = { left: 16, top: 420, right: 100, bottom: 420, width: 84, height: 28 };
        setAnchor({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
        setOpen(true);
        if (!store.loaded && !store.loading) refresh(false);
      }

      function closePicker() {
        setOpen(false);
      }

      function pick(skill) {
        if (!skill) return;
        var inserted = false;
        try {
          if (inputActions && typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function') {
            var span = inputActions.captureInsertion();
            if (span) {
              inserted = inputActions.insertText('/' + str(skill.name) + ' ', span) === true;
            }
          }
        } catch (error) {
          inserted = false;
        }
        if (inserted) {
          rememberSkill(skill.name);
        } else {
          pushToast('插入失败，请手动输入 /' + str(skill.name), { kind: 'error' });
        }
        setOpen(false);
        refocusComposer();
      }

      if (!inputActions) return null;

      var chip = h('button', {
        ref: buttonRef,
        type: 'button',
        className: 'sm-chip',
        title: '选择技能并插入到输入框',
        'aria-label': '选择技能',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        onClick: function () {
          if (open) {
            closePicker();
          } else {
            openPicker();
          }
        }
      },
        h(IconBolt, { size: 13 }),
        h('span', null, '技能')
      );

      var pickerNode = open ? h(SkillPicker, { anchor: anchor, onPick: pick, onClose: closePicker }) : null;
      if (!pickerNode) {
        return h(React.Fragment, null, chip);
      }
      if (ReactDOM) {
        var host = getPortalHost();
        if (host) {
          return h(React.Fragment, null, chip, ReactDOM.createPortal(pickerNode, host));
        }
      }
      return h(React.Fragment, null, chip, pickerNode);
    }

    // ── slot 注册（由宿主 ctx 管理 disposer） ───────────────────────────────
    function apply(ctx) {
      var slots = ctx && ctx.slots ? ctx.slots : null;
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        return function () {};
      }
      var disposers = [];

      function injectSlot(slotName, buildRegistration) {
        try {
          var dispose = slots.inject(slotName, buildRegistration);
          if (typeof dispose === 'function') disposers.push(dispose);
        } catch (error) {
          // 宿主未声明该 slot 时静默跳过，不影响其它入口
        }
      }

      function registerSlots() {
        injectSlot('sidebar.panellist', function () {
          return slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: function () { return '技能管理'; }
          }, PanelIcon);
        });

        injectSlot('main', function () {
          return slots.register({
            name: 'main',
            key: PANEL_ID
          }, Workbench);
        });

        injectSlot('conversation.input.left', function () {
          return slots.register({
            name: 'conversation.input.left',
            id: PICKER_ID,
            order: PICKER_ORDER,
            label: function () { return '技能'; }
          }, ComposerSkillButton);
        });

        return function () {
          for (var i = 0; i < disposers.length; i += 1) {
            try {
              disposers[i]();
            } catch (error) {
              // 忽略单个 disposer 异常
            }
          }
          disposers.length = 0;
          stopTranslation();
        };
      }

      var disposeSlots = null;
      if (typeof ctx.effect === 'function') {
        try {
          var effectDispose = ctx.effect(registerSlots, 'dsh-skill-manager: 侧栏入口 / 工作台 / 对话框选择器');
          if (typeof effectDispose === 'function') disposeSlots = effectDispose;
        } catch (effectError) {
          disposeSlots = registerSlots();
        }
      } else {
        disposeSlots = registerSlots();
      }
      return typeof disposeSlots === 'function' ? disposeSlots : function () {};
    }

    return {
      inject: ['slots'],
      apply: apply
    };
  }
});
