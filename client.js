/**
 * dsh-memory-board ——（2026-09-27 改名；旧名 dsh-memory-panel） Client 半边：设置页里的「本地记忆」一页（中文名「本地记忆」，英文名 Local Memory）。
 *
 * 三条自我约束（都是踩过换来的）：
 *   ①只依赖 `--dsw-alias-*` 主题令牌与 react，**不 import 任何 Harness Client 包** ——
 *     那些包的接口会变，而一个纯 JS 插件没有类型检查；升级后最坏是外观退化，不会白屏。
 *   ②渲染一律"软失败"：字段缺了显示"（读不到）"、接口出错显示错误行；
 *     客户端 slot 条目里抛错会白掉那一块，所以宁可显示半成品。
 *   ③所有写操作都走 Host 的守卫；这边只负责把使用者的字原样送过去，不替谁生成内容。
 */

window.__ModuleLoader__.load({
  id: 'dsh-memory-board',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const API = '/api/memory';
    const MISSING = '（读不到）';

    const TABS = [
      { id: 'overview', label: '概览' },
      { id: 'diary', label: '日记' },
      { id: 'state', label: '状态' },
      { id: 'events', label: '事件流' },
      { id: 'search', label: '搜索' },
    ];

    const SYNC_WHICH = ['合并记忆', '合并日记', '合并状态', '回流包'];

    // 客户端根上下文：apply() 里存下来。目录选择器要用它去软访问 uiWorkspace ——
    // 本插件只 inject 了 slots，绝不为了一个选择器去加 inject（加了就等于把整页押在别人的服务上）。
    let clientCtx = null;

    // ─────────────────────────────────── 指令菜单里的快捷词（2026-09-27 使用者点名要塞进这里的）
    //
    // 使用者的原话：「不要专门做一个插件，日记的就加到本地记忆插件里」；
    // 后来又补：「都放记忆」—— 于是 日记 / 备份 / 收工 三个词都归这里。
    // 做法：往输入框 ➕ 的**指令菜单**（官方那个 ➕，打开的就是输入 `/` 时的命令菜单）各注册一条指令，
    // 点一下 = 发一条**纯文本**词 —— 与使用者在键盘上手打再回车完全一样，
    // 所以档案那套「整行关键词」认词的规矩原样能用（走命令执行面会变成 `/日记`，认不出）。
    // 「换会话」不在本表里：那个词按使用者的要求归 `dsh-session-switch`。
    //
    // 三条自我约束在这里继续成立：不写 DOM、不注册 slot；拿不到输入框就什么都不发（不假装发了）。
    // 依赖只在回调里等（`ctx.inject`），服务没到齐就静默不注册 —— 几条指令而已，不配把整页押上。
    //
    // 加词/改词：只动下面这张表，别的不用碰。

    /** 本插件提供的快捷词：word 是要原样发出去的正文（一个字都不能差），desc 是菜单里那行说明。 */
    const QUICK_WORDS = [
      { word: '日记', desc: '更新日记（写进档案）' },
      { word: '备份', desc: '打包档案备份' },
      { word: '收工', desc: '收尾：今天到这儿' },
      { word: '整理', desc: '整理本地文件，不用的删掉' },
    ];

    /** Console 前缀，好过滤。 */
    const QUICK_LOG = '[记忆板·快捷词] ';

    /**
     * 按会话取输入动作：uiSession 把每个会话的标准 prop 物化成 binding，inputActions 就在里面。
     * ⚠ 本文件的 `quickWordInputActions` / `sendQuickWord` 与 `dsh-session-switch/client.js` 里的
     *   `inputActionsOf` / `sendQuickWord` 是**同一份实现的两份拷贝**（客户端 bundle 各自单文件预打包，
     *   没法跨包 import）。改一个必须改另一个 —— 2026-09-27 用脚本比对过两者语义一致（只有分号/var-const 的风格差）。
     */
    function quickWordInputActions(uiSession, sessionId) {
      if (uiSession === undefined || uiSession === null) return undefined;
      if (typeof uiSession.resolve !== 'function' || sessionId === undefined) return undefined;
      let binding;
      try {
        binding = uiSession.resolve(sessionId);
      } catch {
        return undefined;
      }
      return binding && binding.props ? binding.props.inputActions : undefined;
    }

    /** 发一条词：写草稿 + 提交（提交走队列，正忙时会排队）。拿不到输入框就只留一行 warning。 */
    function sendQuickWord(uiSession, session, text) {
      const actions = quickWordInputActions(uiSession, session && session.sessionId);
      if (actions === undefined || actions === null) {
        console.warn(QUICK_LOG + '「' + text + '」没发出去：这个会话还没挂上输入框');
        return;
      }
      try {
        actions.setDraft(text);
        actions.submit();
      } catch (error) {
        console.warn(QUICK_LOG + '发送失败：' + (error && error.message ? error.message : error));
      }
    }

    // ───────────────────────────────────────────── 样式：只有主题令牌

    const S = {
      section: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '880px', color: 'var(--dsw-alias-label-primary)' },
      heading: { margin: 0, fontSize: '18px', fontWeight: 600 },
      intro: { margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' },
      metaRow: { display: 'flex', flexWrap: 'wrap', gap: '4px 18px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
      tabs: { display: 'flex', gap: '22px', alignItems: 'flex-end', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' },
      tab: { font: 'inherit', fontSize: '13px', lineHeight: '20px', padding: '7px 1px 9px', background: 'none', border: 0, borderBottom: '2px solid transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer' },
      tabActive: { color: 'var(--dsw-alias-label-primary)', borderBottom: '2px solid var(--dsw-alias-label-primary)' },
      cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '10px' },
      card: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0, padding: '10px 12px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '8px' },
      cardTitle: { fontSize: '13px', fontWeight: 600 },
      row: { display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      rowValue: { color: 'var(--dsw-alias-label-primary)', textAlign: 'right', wordBreak: 'break-all', fontVariantNumeric: 'tabular-nums' },
      block: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '8px' },
      blockTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      toolbar: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
      error: { fontSize: '13px', color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap', margin: 0 },
      notice: { fontSize: '13px', color: 'var(--dsw-alias-state-success-primary)', whiteSpace: 'pre-wrap', margin: 0 },
      warning: { fontSize: '13px', color: 'var(--dsw-alias-state-warn-primary)', whiteSpace: 'pre-wrap', margin: 0 },
      list: { display: 'flex', flexDirection: 'column', maxHeight: '420px', overflowY: 'auto', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: '8px' },
      listRow: { display: 'flex', gap: '10px', alignItems: 'baseline', padding: '7px 10px', fontSize: '12.5px', cursor: 'pointer', borderBottom: '0.5px solid var(--dsw-alias-border-l1)' },
      listIndex: { color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums', minWidth: '64px' },
      listMain: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      listSide: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', whiteSpace: 'nowrap' },
      button: { font: 'inherit', fontSize: '12.5px', padding: '5px 12px', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-button-elevated-fill)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      buttonPrimary: { background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)', border: '0.5px solid transparent' },
      buttonDanger: { background: 'var(--dsw-alias-interactive-bg-hover-danger)', border: '0.5px solid var(--dsw-alias-state-error-secondary)', color: 'var(--dsw-alias-state-error-primary)' },
      input: { font: 'inherit', fontSize: '12.5px', width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-l1)', color: 'var(--dsw-alias-label-primary)' },
      textarea: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12.5px', lineHeight: 1.6, width: '100%', boxSizing: 'border-box', minHeight: '220px', resize: 'vertical', padding: '8px 10px', borderRadius: '6px', border: '0.5px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-l1)', color: 'var(--dsw-alias-label-primary)' },
      pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '12.5px', lineHeight: 1.6, maxHeight: '520px', overflow: 'auto', padding: '10px 12px', borderRadius: '8px', border: '0.5px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-l1)' },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
      pathText: { fontSize: '13px', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)' },
    };

    // ───────────────────────────────────────────── 兜底与格式化

    const show = (value) => (value === null || value === undefined || value === '' ? MISSING : String(value));

    function fmtBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return MISSING;
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / 1024 / 1024).toFixed(2)} MB`;
    }

    function fmtTime(value) {
      if (!value) return MISSING;
      try {
        return new Date(value).toLocaleString();
      } catch {
        return String(value);
      }
    }

    /** 把 Host 的结构化失败翻译成一句人话。 */
    function explain(result) {
      if (!result) return '没有响应';
      const parts = [result.reason ? `原因：${result.reason}` : null, result.error ? `错误：${result.error}` : null, result.hint ? `提示：${result.hint}` : null];
      const text = parts.filter(Boolean).join(' · ');
      return text === '' ? JSON.stringify(result) : text;
    }

    // ───────────────────────────────────────────── 取数

    /** 只读拉取。任何异常都变成 error 字段，绝不往外抛。 */
    function useApi(path, enabled = true) {
      const [state, setState] = useState({ loading: Boolean(enabled && path), data: null, error: null });
      const [tick, setTick] = useState(0);
      useEffect(() => {
        if (!enabled || !path) return undefined;
        let alive = true;
        setState((previous) => ({ ...previous, loading: true }));
        fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
          .then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))
          .then(({ status, body }) => {
            if (!alive) return;
            if (!body) setState({ loading: false, data: null, error: `HTTP ${status}` });
            else setState({ loading: false, data: body, error: body.ok === false ? explain(body) : null });
          })
          .catch((error) => {
            if (alive) setState({ loading: false, data: null, error: String((error && error.message) || error) });
          });
        return () => {
          alive = false;
        };
      }, [path, enabled, tick]);
      const reload = useCallback(() => setTick((value) => value + 1), []);
      return { ...state, reload };
    }

    /** 写操作。返回值原样是 Host 的结果（含 ok / reason / hint）。 */
    async function send(path, payload) {
      try {
        const response = await fetch(`${API}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
        });
        const body = await response.json().catch(() => null);
        return body || { ok: false, reason: 'bad-response', error: `HTTP ${response.status}` };
      } catch (error) {
        return { ok: false, reason: 'network', error: String((error && error.message) || error) };
      }
    }

    // ───────────────────────────────────────────── 小组件

    function Row({ label, value }) {
      return h('div', { style: S.row }, h('span', null, label), h('span', { style: S.rowValue }, show(value)));
    }

    function Card({ title, children }) {
      return h('div', { style: S.card }, h('div', { style: S.cardTitle }, title), children);
    }

    function Block({ title, children, extra }) {
      return h(
        'div',
        { style: S.block },
        title === undefined ? null : h('div', { style: S.toolbar }, h('h3', { style: S.blockTitle }, title), extra || null),
        children,
      );
    }

    function Fail({ error, loading }) {
      if (loading) return h('p', { style: S.hint }, '读中…');
      if (!error) return null;
      return h('p', { style: S.error }, error);
    }

    function Field({ label, children }) {
      return h('label', { style: S.field }, h('span', { style: S.label }, label), children);
    }

    /** 面板组件里的任何异常都只降级这一块，不碰整页。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
        this.retry = this.retry.bind(this);
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        try {
          console.error('[memory-panel] 面板组件出错（已降级，不影响页面）：', error);
        } catch {
          /* 没有控制台也要活 */
        }
      }

      retry() {
        this.setState({ error: null });
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { style: S.block },
            h('p', { style: S.error }, `记忆面板出错了（只影响这一块）：${String((this.state.error && this.state.error.message) || this.state.error)}`),
            h('div', { style: S.toolbar }, h('button', { type: 'button', style: S.button, onClick: this.retry }, '重试')),
          );
        }
        return this.props.children;
      }
    }

    // ───────────────────────────────────────────── 写入开关

    function WriteToggle({ onChanged }) {
      const status = useApi('/write/status');
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState(null);
      const snapshot = status.data || {};
      const available = snapshot.available === true;
      const unlocked = snapshot.unlocked === true;

      const flip = async (on) => {
        setBusy(true);
        setMessage(null);
        const result = await send('/write', on ? { on: '1', confirm: 'yes' } : { on: '0' });
        setMessage(result.ok ? (on ? '写入已打开。' : '写入已关掉。') : explain(result));
        setBusy(false);
        status.reload();
        if (onChanged) onChanged();
      };

      const stateText = !available ? '配置只读（要写需先把插件配置里 readOnly 改成 false 并重启）' : unlocked ? '已开' : '关';

      return h(
        'div',
        { style: S.block },
        h(
          'div',
          { style: S.toolbar },
          h('span', { style: { fontSize: '13px' } }, `写入：${stateText}`),
          available
            ? h('button', { type: 'button', style: unlocked ? S.button : { ...S.button, ...S.buttonPrimary }, disabled: busy, onClick: () => flip(!unlocked) }, unlocked ? '关掉写入' : '打开写入')
            : null,
          h('span', { style: S.hint }, '默认只读；开了以后所有写操作仍会：改前备份 → 只改定位处 → 写完复核 → 指纹变了就拒写。'),
        ),
        h(Fail, { error: status.error }),
        message ? h('p', { style: S.warning }, message) : null,
      );
    }

    // ───────────────────────────────────────────── 选择档案位置（面板自己选）

    /** Host 给的位置来源翻成人话（origin 是新增字段，source 是历史字段，两个都认）。 */
    const SOURCE_LABEL = { state: '面板选择', config: '配置', env: '环境变量', detected: '自动识别' };

    function originOf(data) {
      if (!data || !data.root) return null;
      if (data.origin) return data.origin;
      if (data.source === 'config.root') return 'config';
      if (data.source === 'DSH_MEMORY_ROOT') return 'env';
      if (data.source) return 'detected';
      return null;
    }

    /**
     * 官方目录选择器：本机客户端有就用，没有就返回 null（退化成手填路径输入框，不硬依赖）。
     * 两条路都不 import 任何 Harness Client 包（本插件第一条自我约束）：
     *   ① 桌面壳挂在全局上的那个口子 —— 官方 native 客户端插件走的也是它；
     *   ② cordis 的 uiWorkspace 服务 —— 官方 browse/native 客户端插件的同一个口子。
     *      本插件只 inject 了 slots，所以用 ctx.get()：没 inject 的服务在这里给 undefined，
     *      不会像 ctx.uiWorkspace 那样直接抛（真抛了也只是走到"退化"那一支）。
     */
    function directoryPicker() {
      try {
        const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
        if (desktop && typeof desktop.pick === 'function') return () => desktop.pick();
      } catch {
        /* 取不到就当本机没有选择器 */
      }
      try {
        const workspace = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('uiWorkspace') : null;
        if (workspace && typeof workspace.pickDirectory === 'function') return () => workspace.pickDirectory();
      } catch {
        /* 没 inject 时 cordis 会抛 —— 到这里就是"本机没有选择器"，退化到手填 */
      }
      return null;
    }

    /** 展开后的"看一眼再决定"区（原来挤在 LocationBar 里，199 行 → 拆出后两边都在 60 行内）。
     *  纯展示 + 把动作回抛给父组件：状态仍只有 LocationBar 一份。 */
    function LocationChooser({ draft, onDraft, manual, picking, hasPicker, onPick, onManual, onLook }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('p', { style: S.hint }, '选一个目录，先只看一眼它是什么：已有档案 → 认领它；空目录 → 可以在这里铺底；不空又不认识 → 插件不会在这里写任何东西。'),
        h(
          'div',
          { style: S.toolbar },
          h('button', { type: 'button', style: S.button, disabled: picking, onClick: onPick }, picking ? '选择器打开中…' : '用系统目录选择器…'),
          h('button', { type: 'button', style: S.button, onClick: onManual }, '直接填路径'),
          hasPicker ? null : h('span', { style: S.hint }, '本机客户端没有官方目录选择器，手填即可。'),
        ),
        manual
          ? h(
              'div',
              { style: S.toolbar },
              h('input', {
                style: { ...S.input, width: '460px' },
                value: draft,
                placeholder: '例如 D:\\memory\\你的档案根',
                onChange: (event) => onDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && draft.trim() !== '') onLook(draft.trim());
                },
              }),
              h('button', { type: 'button', style: S.button, disabled: draft.trim() === '', onClick: () => onLook(draft.trim()) }, '看一眼'),
            )
          : null,
      );
    }

    /** 只看一眼（GET /where，只读）：这个目录到底是什么，一个字节都不写。
     *  从 LocationBar 里提出来（那边原来 99 行）；setMessage/setProbe 由调用方传进来。 */
    async function look(candidate, setMessage, setProbe) {
      setMessage(null);
      setProbe(null);
      try {
        const response = await fetch(`${API}/where?path=${encodeURIComponent(candidate)}`);
        const body = await response.json().catch(() => null);
        if (!body || body.ok !== true || body.kind === 'missing') {
          setMessage(`这个路径看不了（${body && body.kind ? body.kind : `HTTP ${response.status}`}）：路径要是非空字符串。`);
          return;
        }
        setProbe(body);
      } catch (error) {
        setMessage(`看位置失败：${String((error && error.message) || error)}`);
      }
    }

    /** 先问官方选择器，再退到手填；两条路最后都走 look()。
     *  高阶：把 setters 与 runLook 绑进来，LocationBar 里直接用 pick(false)/pick(true)。 */
    function choose({ keepOpen, setters, runLook }) {
      return async () => {
        setters.setMessage(null);
        setters.setProbe(null);
        if (!keepOpen) setters.setOpen(true);
        const picker = directoryPicker();
        if (!picker) {
          setters.setManual(true);
          setters.setMessage('本机客户端没有官方目录选择器 —— 直接把路径填在下面。');
          return;
        }
        setters.setPicking(true);
        try {
          const picked = await picker();
          if (typeof picked !== 'string' || picked.trim() === '') {
            setters.setManual(true);
            setters.setMessage('没选（取消了）。也可以直接把路径填在下面。');
          } else {
            setters.setDraft(picked);
            await runLook(picked);
          }
        } catch (error) {
          setters.setManual(true);
          setters.setMessage(`目录选择器没打开成功：${String((error && error.message) || error)} —— 路径可以手填。`);
        }
        setters.setPicking(false);
      };
    }

    /** 顶部那一行：现在用的是哪个位置、哪来的、以及「选择位置…」。 */
    function LocationBar({ nonce, onArchiveChanged, onScaffold }) {
      const health = useApi('/health');
      const [open, setOpen] = useState(false);
      const [manual, setManual] = useState(false);
      const [draft, setDraft] = useState('');
      const [picking, setPicking] = useState(false);
      const [probe, setProbe] = useState(null);
      const [message, setMessage] = useState(null);

      // 铺底成功后 Host 那边会自己记住位置：这里只负责把这一行重新读一遍。
      useEffect(() => {
        if (nonce) health.reload();
      }, [nonce]);

      const data = health.data || {};
      const origin = originOf(data);

      /** 把「看一眼」和 setters 绑在一起；「选择位置…」也用同一个 pick。 */
      const runLook = (candidate) => look(candidate, setMessage, setProbe);
      const pick = choose({
        keepOpen: false,
        setters: { setMessage, setProbe, setOpen, setManual, setPicking, setDraft },
        runLook,
      });
      const pickKeepOpen = choose({
        keepOpen: true,
        setters: { setMessage, setProbe, setOpen, setManual, setPicking, setDraft },
        runLook,
      });

      return h(
        Block,
        { title: '档案位置' },
        h(
          'div',
          { style: S.toolbar },
          h('span', { style: { fontSize: '13px' } }, '当前档案位置：'),
          h('span', { style: S.pathText }, data.root ? show(data.root) : '还没定（认不出）'),
          h('span', { style: S.hint }, `（来源：${origin ? SOURCE_LABEL[origin] || origin : '未定'}）`),
          h('button', { type: 'button', style: open ? S.button : { ...S.button, ...S.buttonPrimary }, disabled: picking, onClick: () => (open ? setOpen(false) : pick()) }, open ? '收起' : '选择位置…'),
        ),
        h(Fail, { error: health.error, loading: health.loading && !health.data }),
        open
          ? h(LocationChooser, {
              draft,
              onDraft: setDraft,
              manual,
              picking,
              hasPicker: Boolean(directoryPicker()),
              onPick: pickKeepOpen,
              onManual: () => setManual(true),
              onLook: runLook,
            })
          : null,
        message ? h('p', { style: S.warning }, message) : null,
        probe
          ? h(LocationCard, {
              probe,
              onScaffold,
              onAdopted: () => {
                health.reload();
                if (onArchiveChanged) onArchiveChanged();
              },
            })
          : null,
      );
    }

    /** 看一眼的结果（三态卡片）：archive 认领 / empty 铺底 / partial 什么都不写。 */
    function LocationCard({ probe, onAdopted, onScaffold }) {
      const [claiming, setClaiming] = useState(false);
      const [ack, setAck] = useState('');
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState(null);
      const counts = probe.counts || {};
      const num = (value) => (value === null || value === undefined ? MISSING : value);

      const claim = async () => {
        setBusy(true);
        setMessage(null);
        const result = await send('/adopt', { path: probe.root, confirm: ack });
        if (result.ok) {
          setMessage(`已认领：${result.root}（只写面板自己的状态文件，档案里任何文件都没动）`);
          setClaiming(false);
          setAck('');
          if (onAdopted) onAdopted();
        } else {
          setMessage(explain(result));
        }
        setBusy(false);
      };

      if (probe.kind === 'archive') {
        return h(
          Block,
          { title: '这里已经有一份档案' },
          h('p', { style: S.notice }, `已有档案：日记 ${num(counts.diary)} 条 / 状态 ${num(counts.sections)} 节 / 生长记录 ${num(counts.growth)} 行 / 事件流 ${num(counts.events)} 条`),
          h('p', { style: S.pathText }, probe.root),
          claiming
            ? h(
                'div',
                { style: S.toolbar },
                h('input', { style: { ...S.input, width: '420px' }, value: ack, placeholder: probe.root, onChange: (event) => setAck(event.target.value) }),
                h('button', { type: 'button', style: { ...S.button, ...S.buttonPrimary }, disabled: busy || ack !== probe.root, onClick: claim }, '确认认领'),
                h('button', { type: 'button', style: S.button, onClick: () => { setClaiming(false); setAck(''); setMessage(null); } }, '算了'),
              )
            : h('div', { style: S.toolbar }, h('button', { type: 'button', style: { ...S.button, ...S.buttonPrimary }, onClick: () => setClaiming(true) }, '认领这个档案')),
          h('p', { style: S.hint }, '认领只是把这个位置记进面板自己的状态文件；确认框里要原样打出这个路径（跟真删打序号一个路子）。认领后本页的数字就是这个档案的。'),
          message ? h('p', { style: message.includes('已认领') ? S.notice : S.warning }, message) : null,
        );
      }

      if (probe.kind === 'empty') {
        return h(
          Block,
          { title: '这是个空目录' },
          h('p', { style: S.pathText }, probe.root),
          h('p', { style: S.hint }, probe.note ? probe.note : '这个目录里一个条目都没有。'),
          h(
            'div',
            { style: S.toolbar },
            h('button', { type: 'button', style: { ...S.button, ...S.buttonPrimary }, onClick: () => onScaffold && onScaffold(probe.root) }, '在这里铺底（写入 6 件：身份/开场/日记/状态/生长记录/事件流）'),
            h('span', { style: S.hint }, '还是原来那套铺底：要写入开关开着，还要在表单里再确认一次；铺完插件会自己记住这个位置。'),
          ),
        );
      }

      // partial（也包括"这个路径其实是个文件"）
      return h(
        Block,
        { title: '这里不是档案' },
        h('p', { style: S.pathText }, probe.root),
        h('p', { style: S.warning }, `缺这几个特征文件：${(probe.missing || []).join('、')}`),
        h('p', { style: S.hint }, '不会在这里写任何东西 —— 认不出就不猜、不写。要么把档案补全，要么换一个目录。'),
        probe.note ? h('p', { style: S.hint }, probe.note) : null,
      );
    }

    // ───────────────────────────────────────────── 概览

    function Overview({ write, preset, onLocationChanged }) {
      const info = useApi('/info');
      const data = info.data || {};
      const diary = data.diary || {};
      const state = data.state || {};
      const growth = data.growth || {};
      const stream = data.stream || {};
      const meta = diary.meta || {};

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(Fail, { error: info.error, loading: info.loading && !info.data }),
        h(
          'div',
          { style: S.cards },
          h(
            Card,
            { title: '日记' },
            h(Row, { label: '条目数', value: diary.count === undefined ? null : diary.count }),
            h(Row, { label: '序号范围', value: diary.first === undefined || diary.first === null ? null : `${diary.first} ~ ${diary.last}` }),
            h(Row, { label: '连续性', value: diary.contiguous === undefined ? null : diary.contiguous ? '连续 ✓' : '有断号' }),
            h(Row, { label: '元信息', value: `${meta.lastDiarySeq === null || meta.lastDiarySeq === undefined ? '' : meta.lastDiarySeq} · ${meta.totalCount === null || meta.totalCount === undefined ? '' : meta.totalCount} · v${show(meta.diaryVersion)}` }),
            h(Row, { label: '文件大小', value: fmtBytes(diary.bytes) }),
            h(Row, { label: '最后修改', value: fmtTime(diary.mtime) }),
          ),
          h(
            Card,
            { title: '状态' },
            h(Row, { label: '节数', value: state.sections === undefined ? null : state.sections }),
            h(Row, { label: 'last_updated', value: state.lastUpdated }),
            h(Row, { label: 'diary_count', value: state.diaryCount === undefined ? null : state.diaryCount }),
            h(Row, { label: 'unfinished', value: state.unfinished === undefined ? null : `${state.unfinished} 条` }),
            h(Row, { label: '文件大小', value: fmtBytes(state.bytes) }),
            h(Row, { label: '最后修改', value: fmtTime(state.mtime) }),
          ),
          h(
            Card,
            { title: '生长记录' },
            h(Row, { label: '记录行', value: growth.records === undefined ? null : growth.records }),
            h(Row, { label: '非空行', value: growth.lines === undefined ? null : growth.lines }),
            h(Row, { label: '文件大小', value: fmtBytes(growth.bytes) }),
            h(Row, { label: '最后修改', value: fmtTime(growth.mtime) }),
          ),
          h(
            Card,
            { title: '事件流' },
            h(Row, { label: '条数', value: stream.count === undefined ? null : stream.count }),
            h(Row, { label: '最后一条', value: stream.last }),
            h(Row, { label: '文件大小', value: fmtBytes(stream.bytes) }),
            h(Row, { label: '最后修改', value: fmtTime(stream.mtime) }),
          ),
        ),
        h(GrowthAppend, { write, onDone: info.reload }),
        h(InitForm, { write, preset, onDone: onLocationChanged }),
        h(SyncPanel, null),
        h(
          'div',
          { style: S.toolbar },
          h('button', { type: 'button', style: S.button, onClick: info.reload }, '重新读一遍'),
        ),
      );
    }

    /** 追加一行生长记录。 */
    function GrowthAppend({ write, onDone }) {
      const [line, setLine] = useState('');
      const [message, setMessage] = useState(null);
      const [busy, setBusy] = useState(false);

      const submit = async () => {
        setBusy(true);
        setMessage(null);
        const result = await send('/growth/append', { line, confirm: 'yes' });
        setMessage(result.ok ? (result.changed ? '已追加一行（改前有备份）。' : '这一行已经在文件里了，没有重复写。') : explain(result));
        setBusy(false);
        if (result.ok && result.changed) {
          setLine('');
          if (onDone) onDone();
        }
      };

      return h(
        Block,
        { title: '追加一行生长记录' },
        h('p', { style: S.hint }, '一行一条，行首自己带 `YYYY-MM-DD HH:MM | 【设备】 | 正文`。同一行不会写第二遍。'),
        h(Field, { label: '这一行' }, h('input', { style: S.input, value: line, onChange: (event) => setLine(event.target.value), placeholder: '2026-01-01 09:00 | 【设备】 | 做了什么' })),
        h(
          'div',
          { style: S.toolbar },
          h('button', { type: 'button', style: { ...S.button, ...S.buttonPrimary }, disabled: busy || line.trim() === '' || !write.allowed, onClick: submit }, '写入'),
          write.allowed ? null : h('span', { style: S.hint }, '写入开关没开（或配置只读）。'),
        ),
        message ? h('p', { style: message.includes('已追加') || message.includes('没有重复写') ? S.notice : S.warning }, message) : null,
      );
    }

    // ───────────────────────────────────────────── 新设备铺底

    function InitForm({ write, preset, onDone }) {
      const [open, setOpen] = useState(false);
      const [root, setRoot] = useState('');
      const [device, setDevice] = useState('【新设备】');
      const [message, setMessage] = useState(null);
      const [result, setResult] = useState(null);
      const [busy, setBusy] = useState(false);

      // 顶部那行「在这里铺底」会把目标目录递进来：自动展开表单并填好路径（写入开关仍要自己开）。
      useEffect(() => {
        if (preset && typeof preset.root === 'string') {
          setOpen(true);
          setRoot(preset.root);
        }
      }, [preset]);

      const submit = async () => {
        setBusy(true);
        setMessage(null);
        setResult(null);
        const response = await send('/init', { root, device, confirm: 'yes' });
        setMessage(response.ok ? '铺底完成。' : explain(response));
        setResult(response);
        setBusy(false);
        // 铺底成功 → Host 已把位置记进状态文件，这里只要让面板重新读一遍。
        if (response.ok && onDone) onDone();
      };

      return h(
        Block,
        { title: '在这台设备上铺底（新设备初始化）' },
        h('p', { style: S.hint }, '建 6 个目录 + 6 件骨架文件（全 CRLF）。骨架里到处标【占位】并写明"这是骨架，不是谁的记忆"——绝不假造任何经历。目录里已有档案一律拒绝，本面板也不会覆盖任何已存在的文件。目标目录必须你自己填。'),
        h(
          'div',
          { style: S.toolbar },
          h('button', { type: 'button', style: S.button, onClick: () => setOpen((value) => !value) }, open ? '收起' : '我要铺底…'),
        ),
        open
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h(Field, { label: '目标目录（必须是一个新的空目录，自己填）' }, h('input', { style: S.input, value: root, onChange: (event) => setRoot(event.target.value), placeholder: '例如 D:\\dsh\\新设备记忆' })),
              h(Field, { label: '设备标签' }, h('input', { style: S.input, value: device, onChange: (event) => setDevice(event.target.value), placeholder: '【设备】' })),
              h(
                'div',
                { style: S.toolbar },
                h('button', { type: 'button', style: { ...S.button, ...S.buttonDanger }, disabled: busy || root.trim() === '' || !write.allowed, onClick: submit }, '在这台设备上铺底'),
                write.allowed ? null : h('span', { style: S.hint }, '写入开关没开（或配置只读）。'),
              ),
            )
          : null,
        message ? h('p', { style: result && result.ok ? S.notice : S.warning }, message) : null,
        result && result.ok
          ? h('pre', { style: S.pre }, (result.files || []).map((file) => `${file.path}  ${file.bytes} B  ← ${file.from}`).join('\n'))
          : null,
        result && !result.ok && result.existing ? h('p', { style: S.warning }, `已存在、拒绝覆盖：${result.existing.join('、')}`) : null,
      );
    }

    // ───────────────────────────────────────────── 同步（调脚本，不自己重写合并）

    /** 「真合并」那一区：从 SyncPanel 提出来（那边原来 76 行）。四道闸的说明 + 四个要打名字的按钮。 */
    function SyncMergeSection({ whichList, ack, setAck, busy, onMerge }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('p', { style: S.hint }, '真合并要过四道闸：①在白名单里 ②写入开关开着 ③先跑一次干跑并把报告一起带回来 ④下面这格必须**原样打出脚本名**。'),
        whichList.map((which) =>
          h(
            'div',
            { key: which, style: S.toolbar },
            h('span', { style: { fontSize: '12.5px', minWidth: '72px' } }, which),
            h('input', {
              style: { ...S.input, width: '160px' },
              value: ack[which] || '',
              placeholder: which,
              onChange: (event) => setAck({ ...ack, [which]: event.target.value }),
            }),
            h('button', { type: 'button', style: { ...S.button, ...S.buttonDanger }, disabled: busy !== null || (ack[which] || '') !== which, onClick: () => onMerge(which) }, `真跑 ${which} --apply`),
          ),
        ),
      );
    }

    function SyncPanel() {
      const status = useApi('/sync/status');
      const [report, setReport] = useState(null);
      const [busy, setBusy] = useState(null);
      const [ack, setAck] = useState({});
      const [message, setMessage] = useState(null);
      const data = status.data || {};

      const dryrun = async (which) => {
        setBusy(which);
        setMessage(null);
        const result = await send(`/sync/dryrun?which=${encodeURIComponent(which)}`, {});
        setReport({ which, kind: '干跑', result });
        setBusy(null);
      };

      const merge = async (which) => {
        setBusy(which);
        setMessage(null);
        const result = await send('/sync/merge', { which, ack: ack[which] || '', confirm: 'yes' });
        setReport({ which, kind: '真跑', result, dryrun: result.dryrun });
        if (!result.ok) setMessage(explain(result));
        setBusy(null);
      };

      return h(
        Block,
        { title: '同步（跨设备合并仍走档案里那几个脚本，不自己实现第二套）' },
        h('p', { style: S.hint }, '白名单只有 合并记忆.py / 合并日记.py / 合并状态.py / 回流包.py；干跑明确不带 --apply。恢复.py / 备份.py / 自主轮次.py 永不放行（没有干跑闸门 / 会删历史包 / 名义干跑也写盘）。'),
        h(Fail, { error: status.error, loading: status.loading && !status.data }),
        h(
          'div',
          { style: S.cards },
          h(
            Card,
            { title: `档案里的包（${(data.packages || []).length}）` },
            (data.packages || []).length === 0
              ? h('p', { style: S.hint }, '没有包。')
              : (data.packages || []).map((item) => h(Row, { key: item.name, label: item.name, value: `${fmtBytes(item.size)} · ${fmtTime(item.mtime)}` })),
          ),
          h(
            Card,
            { title: '三个收件箱' },
            (data.inboxes || []).length === 0
              ? h('p', { style: S.hint }, MISSING)
              : (data.inboxes || []).map((box) => h(Row, { key: box.label, label: box.label, value: `${box.count} 个` })),
          ),
        ),
        h(
          'div',
          { style: S.toolbar },
          SYNC_WHICH.map((which) => h('button', { key: which, type: 'button', style: S.button, disabled: busy !== null, onClick: () => dryrun(which) }, `干跑 ${which}`)),
        ),
        h(SyncMergeSection, { whichList: SYNC_WHICH, ack, setAck, busy, onMerge: merge }),
        message ? h('p', { style: S.warning }, message) : null,
        report ? h(ReportView, { report }) : null,
      );
    }

    function ReportView({ report }) {
      const lines = [];
      const push = (label, result) => {
        if (!result) return;
        lines.push(`── ${label} ──`);
        lines.push(`退出码 ${result.exitCode === undefined || result.exitCode === null ? MISSING : result.exitCode}  用时 ${result.durationMs === undefined ? MISSING : `${result.durationMs} ms`}  ${result.applied ? '（带了 --apply）' : '（干跑，不带 --apply）'}`);
        if (result.error) lines.push(`进程错误：${result.error}`);
        if (result.stdout) lines.push(result.stdout.replace(/\s+$/, ''));
        if (result.stderr) lines.push(`[stderr] ${result.stderr.replace(/\s+$/, '')}`);
        lines.push('');
      };
      push(`${report.which} 干跑`, report.dryrun || (report.kind === '干跑' ? report.result : null));
      if (report.kind === '真跑') push(`${report.which} 真跑`, report.result && report.result.applied ? report.result.applied : null);
      return h('pre', { style: S.pre }, lines.join('\n'));
    }

    // ───────────────────────────────────────────── 日记

    function DiaryPane({ write }) {
      const list = useApi('/diary');
      const [seq, setSeq] = useState(null);
      const data = list.data || {};
      const entries = useMemo(() => (data.entries || []).slice().reverse(), [data.entries]);
      const refresh = useCallback(() => list.reload(), [list.reload]);

      if (seq !== null) {
        return h(DiaryDetail, { seq, fingerprint: data.fingerprint, write, onBack: () => setSeq(null), onChanged: refresh });
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(Fail, { error: list.error, loading: list.loading && !list.data }),
        h(
          'div',
          { style: S.toolbar },
          h('span', { style: S.hint }, `共 ${data.count === undefined ? MISSING : data.count} 条（列表按倒序：最新在前）`),
          h('button', { type: 'button', style: S.button, onClick: refresh }, '刷新'),
        ),
        h(DiaryAppendForm, { write, onDone: refresh }),
        h(
          'div',
          { style: S.list },
          entries.map((entry) =>
            h(
              'div',
              { key: entry.seq, style: S.listRow, onClick: () => setSeq(entry.seq) },
              h('span', { style: S.listIndex }, `#${entry.seq}`),
              h('span', { style: S.listMain }, `${show(entry.date)} ｜ ${show(entry.time)}`),
              h('span', { style: S.listSide }, `${entry.device ? entry.device : '（无标签）'} ｜ ${show(entry.format)} ｜ ${entry.chars} 字`),
            ),
          ),
          entries.length === 0 ? h('p', { style: { ...S.hint, padding: '10px 12px' } }, '一条日记都没有。') : null,
        ),
      );
    }

    function DiaryDetail({ seq, fingerprint, write, onBack, onChanged }) {
      const detail = useApi(`/diary?seq=${encodeURIComponent(seq)}`);
      const [deleting, setDeleting] = useState(false);
      const [ack, setAck] = useState('');
      const [message, setMessage] = useState(null);
      const [busy, setBusy] = useState(false);

      const remove = async () => {
        setBusy(true);
        setMessage(null);
        const result = await send('/diary/delete', { seq, ack, fp: detail.data ? detail.data.fingerprint : fingerprint, confirm: 'yes' });
        setMessage(result.ok ? `已真删 #${seq}。删掉的内容存在：${result.archive || MISSING}` : explain(result));
        setBusy(false);
        if (result.ok) onChanged();
      };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h(
          'div',
          { style: S.toolbar },
          h('button', { type: 'button', style: S.button, onClick: onBack }, '← 返回列表'),
          h('span', { style: S.hint }, detail.data && detail.data.entry ? `#${detail.data.entry.seq} ｜ ${show(detail.data.entry.date)} ｜ ${show(detail.data.entry.time)} ｜ ${detail.data.entry.device || '（无标签）'}` : ''),
        ),
        h(Fail, { error: detail.error, loading: detail.loading && !detail.data }),
        detail.data && detail.data.text ? h('pre', { style: S.pre }, detail.data.text) : null,
        h(
          Block,
          { title: '真删这一条' },
          h('p', { style: S.hint }, '三道防线：删前备份整份文件 + 删掉的内容另存进 归档-旧版本与记录\\删除内容\\ + 这里必须**原样打出序号**才放行。刻意不改序号（日记是流水账，留洞比改号轻）。'),
          h('p', { style: S.warning }, '真删之后文件里就真的没有这一段了。'),
          deleting
            ? h(
                'div',
                { style: S.toolbar },
                h('input', { style: { ...S.input, width: '140px' }, value: ack, placeholder: `#${seq}`, onChange: (event) => setAck(event.target.value) }),
                h('button', { type: 'button', style: { ...S.button, ...S.buttonDanger }, disabled: busy || ack.trim() !== `#${seq}` || !write.allowed, onClick: remove }, '真删'),
                h('button', { type: 'button', style: S.button, onClick: () => { setDeleting(false); setAck(''); setMessage(null); } }, '算了'),
              )
            : h('div', { style: S.toolbar }, h('button', { type: 'button', style: S.button, onClick: () => setDeleting(true) }, '删除…')),
          message ? h('p', { style: message.includes('已真删') ? S.notice : S.warning }, message) : null,
        ),
      );
    }

    const EMPTY_DIARY_FORM = { date: '', time: '', device: '', event: '', userMood: '', moodTags: '', notes: '', details: '', moodTail: '' };

    function DiaryAppendForm({ write, onDone }) {
      const [open, setOpen] = useState(false);
      const [form, setForm] = useState(EMPTY_DIARY_FORM);
      const [message, setMessage] = useState(null);
      const [busy, setBusy] = useState(false);
      const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

      const submit = async () => {
        setBusy(true);
        setMessage(null);
        const now = new Date();
        const pad = (value) => String(value).padStart(2, '0');
        const result = await send('/diary/append', {
          ...form,
          date: form.date || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
          time: form.time || `${pad(now.getHours())}:${pad(now.getMinutes())}`,
          confirm: 'yes',
        });
        if (result.ok) {
          setMessage(result.changed ? `已写入 #${result.seq}（改前有备份）。` : `#${result.seq} 的内容已经在文件里了，没有重复写。`);
          if (result.changed) {
            setForm(EMPTY_DIARY_FORM);
            onDone();
          }
        } else {
          setMessage(explain(result));
        }
        setBusy(false);
      };

      return h(
        Block,
        { title: '＋ 新增日记条目' },
        h('p', { style: S.hint }, '表单不生成任何内容：写什么由你定。序号取 last_diary_seq + 1，元信息两处跟着 +1，diary_version 按档案自带的规则升位。'),
        h('div', { style: S.toolbar }, h('button', { type: 'button', style: S.button, onClick: () => setOpen((value) => !value) }, open ? '收起' : '展开表单')),
        open
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h(
                'div',
                { style: S.grid2 },
                h(Field, { label: '日期（留空用今天）' }, h('input', { style: S.input, value: form.date, onChange: set('date'), placeholder: 'YYYY-MM-DD' })),
                h(Field, { label: '时间（留空用现在）' }, h('input', { style: S.input, value: form.time, onChange: set('time'), placeholder: 'HH:MM' })),
                h(Field, { label: '设备标签（可留空）' }, h('input', { style: S.input, value: form.device, onChange: set('device'), placeholder: '【PC】（留空自动补本机）' })),
              ),
              h(Field, { label: 'event_description（这一轮在做什么）' }, h('textarea', { style: { ...S.textarea, minHeight: '90px' }, value: form.event, onChange: set('event') })),
              h(Field, { label: 'user_mood（用户心情，一句话）' }, h('input', { style: S.input, value: form.userMood, onChange: set('userMood') })),
              h(Field, { label: 'mood_tags（3~5 个短标签，顿号分隔）' }, h('input', { style: S.input, value: form.moodTags, onChange: set('moodTags') })),
              h(Field, { label: 'notes（小笔记，可多行）' }, h('textarea', { style: { ...S.textarea, minHeight: '70px' }, value: form.notes, onChange: set('notes') })),
              h(Field, { label: 'lively_details（一行一个细节）' }, h('textarea', { style: { ...S.textarea, minHeight: '70px' }, value: form.details, onChange: set('details') })),
              h(Field, { label: 'mood_tail（收尾心情句）' }, h('input', { style: S.input, value: form.moodTail, onChange: set('moodTail') })),
              h(
                'div',
                { style: S.toolbar },
                h('button', { type: 'button', style: { ...S.button, ...S.buttonPrimary }, disabled: busy || form.event.trim() === '' || !write.allowed, onClick: submit }, '写入日记'),
                write.allowed ? null : h('span', { style: S.hint }, '写入开关没开（或配置只读）。'),
              ),
            )
          : null,
        message ? h('p', { style: message.includes('已写入') || message.includes('没有重复写') ? S.notice : S.warning }, message) : null,
      );
    }

    // ───────────────────────────────────────────── 状态

    function StatePane({ write }) {
      const list = useApi('/state');
      const [title, setTitle] = useState(null);
      const data = list.data || {};
      const refresh = useCallback(() => list.reload(), [list.reload]);

      if (title !== null) {
        return h(StateDetail, { title, fingerprint: data.fingerprint, write, onBack: () => setTitle(null), onChanged: refresh });
      }

      const meta = data.meta || {};
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(Fail, { error: list.error, loading: list.loading && !list.data }),
        h(
          'div',
          { style: S.toolbar },
          h('span', { style: S.hint }, `共 ${data.count === undefined ? MISSING : data.count} 节（档案里最新在前）`),
          h('span', { style: S.hint }, `last_updated ${show(meta.lastUpdated)} ｜ diary_count ${show(meta.diaryCount)} ｜ unfinished ${meta.unfinished === undefined ? MISSING : meta.unfinished} 条`),
          h('button', { type: 'button', style: S.button, onClick: refresh }, '刷新'),
        ),
        h(
          'div',
          { style: S.list },
          (data.sections || []).map((section) =>
            h(
              'div',
              { key: section.title, style: S.listRow, onClick: () => setTitle(section.title) },
              h('span', { style: S.listMain }, section.title),
              h('span', { style: S.listSide }, `${section.chars} 字`),
            ),
          ),
          (data.sections || []).length === 0 ? h('p', { style: { ...S.hint, padding: '10px 12px' } }, '一个节都没有。') : null,
        ),
      );
    }

    /** 改这一节正文的那一块（从 StateDetail 提出来，那边原来 82 行）。 */
    function StateEditBlock({ editing, setEditing, draft, setDraft, currentText, busy, write, onSave, onCancel }) {
      return editing
        ? h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h(Field, { label: '这一节的正文（标题行不在这里，改不了）' }, h('textarea', { style: S.textarea, value: draft === null ? '' : draft, onChange: (event) => setDraft(event.target.value) })),
            h(
              'div',
              { style: S.toolbar },
              h('button', { type: 'button', style: { ...S.button, ...S.buttonPrimary }, disabled: busy || !write.allowed, onClick: onSave }, '保存正文'),
              h('button', { type: 'button', style: S.button, onClick: onCancel }, '取消'),
            ),
          )
        : h(
            'div',
            { style: S.toolbar },
            h('button', { type: 'button', style: S.button, onClick: () => setEditing(true) }, '编辑本节'),
          );
    }

    /** StateDetail 底部那条结果消息（原来两处内联三元挤在一起）。 */
    function StateNotice({ message, deleting }) {
      if (!message || deleting) return null;
      return h('p', { style: message.includes('已保存') || message.includes('什么都没写') ? S.notice : S.warning }, message);
    }

    /** 「真删这一节」那一块：整块搬出 StateDetail（那边原来 89 行，含这块的 JSX 占了大半）。 */
    function StateDeleteBlock({ title, ack, setAck, deleting, setDeleting, busy, write, message, setMessage, onRemove }) {
      return h(
        Block,
        { title: '真删这一节' },
        h('p', { style: S.hint }, '删掉的是整节（连 `## 标题` 一起）。删前备份整份文件 + 删掉的内容另存归档区 + 这里必须**原样打出节标题**才放行。'),
        deleting
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              h('input', { style: S.input, value: ack, placeholder: title, onChange: (event) => setAck(event.target.value) }),
              h(
                'div',
                { style: S.toolbar },
                h('button', { type: 'button', style: { ...S.button, ...S.buttonDanger }, disabled: busy || ack !== title || !write.allowed, onClick: onRemove }, '真删这一节'),
                h('button', { type: 'button', style: S.button, onClick: () => { setDeleting(false); setAck(''); setMessage(null); } }, '算了'),
              ),
            )
          : h('div', { style: S.toolbar }, h('button', { type: 'button', style: S.button, onClick: () => setDeleting(true) }, '删除…')),
        message && deleting ? h('p', { style: message.includes('已真删') ? S.notice : S.warning }, message) : null,
      );
    }

    function StateDetail({ title, fingerprint, write, onBack, onChanged }) {
      const detail = useApi(`/state?title=${encodeURIComponent(title)}`);
      const [draft, setDraft] = useState(null);
      const [editing, setEditing] = useState(false);
      const [deleting, setDeleting] = useState(false);
      const [ack, setAck] = useState('');
      const [message, setMessage] = useState(null);
      const [busy, setBusy] = useState(false);

      const currentText = detail.data && typeof detail.data.text === 'string' ? detail.data.text : '';
      useEffect(() => {
        setDraft(currentText);
      }, [currentText]);

      const save = async () => {
        setBusy(true);
        setMessage(null);
        const result = await send('/state/edit', { title, body: draft === null ? '' : draft, fp: detail.data ? detail.data.fingerprint : fingerprint, confirm: 'yes' });
        setMessage(result.ok ? (result.changed ? '已保存（改前有备份，标题行与别的节没动）。' : '正文没变，什么都没写。') : explain(result));
        setBusy(false);
        if (result.ok && result.changed) {
          setEditing(false);
          onChanged();
          detail.reload();
        }
      };

      const remove = async () => {
        setBusy(true);
        setMessage(null);
        const result = await send('/state/delete', { title, ack, fp: detail.data ? detail.data.fingerprint : fingerprint, confirm: 'yes' });
        setMessage(result.ok ? `已真删这一节。删掉的内容存在：${result.archive || MISSING}` : explain(result));
        setBusy(false);
        if (result.ok) {
          onChanged();
          onBack();
        }
      };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h(
          'div',
          { style: S.toolbar },
          h('button', { type: 'button', style: S.button, onClick: onBack }, '← 返回分节列表'),
          h('span', { style: S.hint }, title),
        ),
        h(Fail, { error: detail.error, loading: detail.loading && !detail.data }),
        h(StateEditBlock, {
          editing,
          setEditing,
          draft,
          setDraft,
          currentText,
          busy,
          write,
          onSave: save,
          onCancel: () => { setEditing(false); setDraft(currentText); setMessage(null); },
        }),
        editing ? null : h('pre', { style: S.pre }, currentText === '' ? MISSING : currentText),
        h(StateDeleteBlock, {
          title,
          ack,
          setAck,
          deleting,
          setDeleting,
          busy,
          write,
          message,
          setMessage,
          onRemove: remove,
        }),
        h(StateNotice, { message, deleting }),
      );
    }

    // ───────────────────────────────────────────── 事件流 / 搜索

    function EventsPane() {
      const [limit, setLimit] = useState(30);
      const events = useApi(`/events?limit=${limit}`);
      const data = events.data || {};
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h(
          'div',
          { style: S.toolbar },
          h('span', { style: S.hint }, `事件流共 ${data.total === undefined ? MISSING : data.total} 条（只追加，永不改）`),
          h('button', { type: 'button', style: S.button, onClick: () => setLimit(30) }, '最近 30'),
          h('button', { type: 'button', style: S.button, onClick: () => setLimit(100) }, '最近 100'),
          h('button', { type: 'button', style: S.button, onClick: () => setLimit(300) }, '最近 300'),
          h('button', { type: 'button', style: S.button, onClick: events.reload }, '刷新'),
        ),
        h(Fail, { error: events.error, loading: events.loading && !events.data }),
        h(
          'div',
          { style: S.list },
          (data.entries || []).map((entry, index) =>
            h(
              'div',
              { key: `${entry.id || 'x'}-${index}`, style: { ...S.listRow, cursor: 'default', flexDirection: 'column', alignItems: 'stretch', gap: '3px' } },
              h('div', { style: S.toolbar }, h('span', { style: S.listIndex }, show(entry.ts)), h('span', null, show(entry.kind)), h('span', { style: S.listSide }, show(entry.source)), h('span', { style: S.listIndex }, entry.id || '')),
              h('div', { style: { fontSize: '12.5px' } }, show(entry.topic)),
              h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, show(entry.excerpt)),
            ),
          ),
          (data.entries || []).length === 0 ? h('p', { style: { ...S.hint, padding: '10px 12px' } }, '事件流是空的。') : null,
        ),
      );
    }

    function SearchPane() {
      const [query, setQuery] = useState('');
      const [submitted, setSubmitted] = useState('');
      const path = submitted === '' ? null : `/search?q=${encodeURIComponent(submitted)}&limit=100`;
      const result = useApi(path, submitted !== '');
      const data = result.data || {};
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('p', { style: S.hint }, '只读过滤 记忆\\事件流.jsonl，空格分词、全部命中才算命中。刻意不调 `记忆.py search`——那个命令在索引过期时会重建索引（写盘）。'),
        h(
          'div',
          { style: S.toolbar },
          h('input', { style: { ...S.input, width: '320px' }, value: query, onChange: (event) => setQuery(event.target.value), placeholder: '关键词，空格分词', onKeyDown: (event) => { if (event.key === 'Enter') setSubmitted(query.trim()); } }),
          h('button', { type: 'button', style: { ...S.button, ...S.buttonPrimary }, onClick: () => setSubmitted(query.trim()) }, '搜'),
        ),
        h(Fail, { error: result.error, loading: result.loading }),
        submitted === '' ? null : h('p', { style: S.hint }, `扫了 ${data.scanned === undefined ? MISSING : data.scanned} 条，命中 ${data.total === undefined ? MISSING : data.total} 条${data.note ? `（${data.note}）` : ''}`),
        h(
          'div',
          { style: S.list },
          (data.hits || []).map((entry, index) =>
            h(
              'div',
              { key: `${entry.id || 'x'}-${index}`, style: { ...S.listRow, cursor: 'default', flexDirection: 'column', alignItems: 'stretch', gap: '3px' } },
              h('div', { style: S.toolbar }, h('span', { style: S.listIndex }, show(entry.ts)), h('span', null, show(entry.kind)), h('span', { style: S.listIndex }, show(entry.ref))),
              h('div', { style: { fontSize: '12.5px' } }, show(entry.topic)),
              h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, show(entry.excerpt)),
            ),
          ),
        ),
      );
    }

    // ───────────────────────────────────────────── 面板本体

    function MemoryPanel() {
      const [tab, setTab] = useState('overview');
      // preset：顶部「在这里铺底」把目标目录递给概览里的铺底表单；locationNonce：铺完让顶部那行重读一次。
      const [preset, setPreset] = useState(null);
      const [locationNonce, setLocationNonce] = useState(0);
      const info = useApi('/info');
      const status = useApi('/write/status');
      // 开关一变，新的 status.data 会让这个对象换一次身份，各分段的按钮跟着解禁/禁用。
      const write = useMemo(
        () => ({ allowed: Boolean(status.data && status.data.allowed), available: Boolean(status.data && status.data.available) }),
        [status.data],
      );
      const bumpWrite = useCallback(() => status.reload(), [status.reload]);

      const readOnly = info.data ? info.data.readOnly === true : null;

      return h(
        PanelBoundary,
        null,
        h(
          'div',
          { style: S.section },
          h('h2', { style: S.heading }, '本地记忆'),
          h('p', { style: S.intro }, '记忆档案的看 / 搜 / 编 / 新增。文件仍是权威：不搬家、不建数据库、不改任何文件格式；跨设备合并仍走档案里原有的那几个脚本。'),
          h(LocationBar, {
            nonce: locationNonce,
            onArchiveChanged: info.reload,
            onScaffold: (target) => {
              setPreset({ root: target, nonce: Date.now() });
              setTab('overview');
            },
          }),
          h('div', { style: S.metaRow }, h('span', null, `只读模式：${readOnly === null ? MISSING : readOnly ? '是' : '否'}`)),
          h(Fail, { error: info.error, loading: info.loading && !info.data }),
          h(WriteToggle, { onChanged: bumpWrite }),
          h(
            'div',
            { style: S.tabs, role: 'tablist' },
            TABS.map((item) =>
              h(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': tab === item.id,
                  style: tab === item.id ? { ...S.tab, ...S.tabActive } : S.tab,
                  onClick: () => setTab(item.id),
                },
                item.label,
              ),
            ),
          ),
          tab === 'overview'
            ? h(Overview, {
                write,
                preset,
                onLocationChanged: () => {
                  setLocationNonce((value) => value + 1);
                  info.reload();
                },
              })
            : null,
          tab === 'diary' ? h(DiaryPane, { write }) : null,
          tab === 'state' ? h(StatePane, { write }) : null,
          tab === 'events' ? h(EventsPane, null) : null,
          tab === 'search' ? h(SearchPane, null) : null,
        ),
      );
    }

    // ───────────────────────────────────────────── 注册

    return {
      inject: ['slots'],
      apply(ctx) {
        clientCtx = ctx; // 只存引用、不当场读服务：真读 uiWorkspace 要等点击那一下（那时才可能已经有）
        // 只在 apply 的同步阶段碰已 inject 的 slots；别的服务一律不读（读了会抛，整页打不开）。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'memory', order: 120, label: '本地记忆' },
            MemoryPanel,
          ),
        );
        try {
          console.info('[memory-panel] 已注册设置页「本地记忆」（id=memory / order=120 / 顶部「档案位置」+ 五个分段 概览·日记·状态·事件流·搜索）');
        } catch {
          /* 没有控制台也要活 */
        }

        // 输入框 ➕ 指令菜单里的快捷词（使用者 2026-09-27 点名；表见本文件上方的 QUICK_WORDS）。
        // 用 ctx.inject 等两个服务，不在同步阶段直接读它们 —— 服务没到齐就当没这回事，面板照常。
        try {
          ctx.inject(['commandUi', 'uiSession'], (scope) => {
            for (const item of QUICK_WORDS) {
              try {
                scope.effect(
                  () =>
                    scope.commandUi.register({
                      name: item.word,
                      available: () => true,
                      description: () => item.desc,
                      ui: {
                        kind: 'action',
                        run: (session) => sendQuickWord(scope.uiSession, session, item.word),
                      },
                    }),
                  'dsh-memory-board: /' + item.word,
                );
              } catch (error) {
                console.warn(QUICK_LOG + '注册「' + item.word + '」失败：' + (error && error.message ? error.message : error));
              }
            }
            console.info('[memory-panel] 已在指令菜单里注册快捷词：' + QUICK_WORDS.map((it) => it.word).join(' / '));
          });
        } catch (error) {
          console.warn(QUICK_LOG + '注册快捷词失败：' + (error && error.message ? error.message : error));
        }
      },
    };
  },
});
