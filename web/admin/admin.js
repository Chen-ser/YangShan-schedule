// 公告管理页 —— 纯静态、零依赖、没有后端。
//
// 它是怎么在没有服务器的情况下「发布」的：直接用 GitHub API 提交 data/announcements.json。
// 那个文件就是公告的权威源，站点上那份是构建时从它复制过去的；应用端读站点上那份。
//
// 这个文件被 build.mjs 拼在 core 之后，所以可以直接用 core/model.mjs 里的
// encodeAnnConfig / ntfyPublishUrl / normalizeAnnouncements 等函数（别重名）。

const LS_ADMIN = 'yangshan-admin/v1';
const $id = (id) => document.getElementById(id);

// 公告类别。发布时写进 JSON 的 category 字段，应用端只把它当卡片上的小标签。
// 应用端刻意不做白名单（别人手写的「选课」「寒暑假」不该被丢掉），所以以后往这里加值不会让老数据失效。
const CATEGORIES = ['通知', '调课', '考试', '活动', '其它'];

const DEFAULT_CFG = {
  repo: 'Chen-ser/YangShan-schedule',
  branch: 'main',
  path: 'data/announcements.json',
  token: '',
  topic: '',
};

let cfg = { ...DEFAULT_CFG };
let list = [];          // 正在编辑的公告（未归一化，原样保留字段）
let remoteSha = '';     // 上次读到的 blob sha —— 提交时必须带回去，否则会覆盖别人的改动
let remoteExtra = {};   // 文件里的其它顶层字段（_说明 之类），提交时原样保留
let editingIdx = -1;    // -1 = 正在新增

// ---------------------------------------------------------------- 配置存取

function loadCfg() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_ADMIN) || '{}');
    cfg = { ...DEFAULT_CFG, ...raw };
  } catch {
    cfg = { ...DEFAULT_CFG };
  }
}

function saveCfg() {
  try {
    localStorage.setItem(LS_ADMIN, JSON.stringify(cfg));
  } catch (e) {
    setHint('connHint', '配置存不进 localStorage：' + e.message, 'bad');
  }
}

function fillCfgInputs() {
  $id('cfgRepo').value = cfg.repo;
  $id('cfgBranch').value = cfg.branch;
  $id('cfgPath').value = cfg.path;
  $id('cfgToken').value = cfg.token;
  $id('cfgTopic').value = cfg.topic;
  $id('manualPath').textContent = cfg.path;
}

function readCfgInputs() {
  cfg.repo = $id('cfgRepo').value.trim();
  cfg.branch = $id('cfgBranch').value.trim() || 'main';
  cfg.path = $id('cfgPath').value.trim() || 'data/announcements.json';
  cfg.token = $id('cfgToken').value.trim();
  cfg.topic = $id('cfgTopic').value.trim();
  saveCfg();
}

function setHint(id, text, kind = '') {
  const el = $id(id);
  el.textContent = text || '';
  el.className = 'hint' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------- base64（UTF-8 安全）

function b64decodeUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function b64encodeUtf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ---------------------------------------------------------------- GitHub API

function repoParts() {
  const parts = cfg.repo.split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) throw new Error('仓库要写成 owner/repo 的形式，例如 Chen-ser/YangShan-schedule');
  return parts;
}

/** 把仓库内路径拼进 contents API 的 URL（保留斜杠、转义其它字符）。 */
function contentsUrl() {
  const enc = cfg.path.split('/').map(encodeURIComponent).join('/');
  return `/contents/${enc}`;
}

async function ghApi(pathAndQuery, init = {}) {
  const [owner, repo] = repoParts();
  return fetch(`https://api.github.com/repos/${owner}/${repo}${pathAndQuery}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      ...(init.headers || {}),
    },
  });
}

/** 从 GitHub 的错误响应里抠出人话。 */
async function ghError(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.message || '';
    if (Array.isArray(j?.errors) && j.errors.length) {
      detail += '（' + j.errors.map((e) => e.message || JSON.stringify(e)).join('；') + '）';
    }
  } catch {
    /* 响应不是 JSON 就算了 */
  }
  if (res.status === 401) detail = detail || '令牌无效或已过期';
  if (res.status === 403) detail = detail || '令牌权限不足，确认勾了 Contents: Read and write';
  if (res.status === 404) detail = detail || '仓库或文件路径找不到（也可能是令牌没授权这个仓库）';
  return `HTTP ${res.status}${detail ? ' · ' + detail : ''}`;
}

async function readRemote() {
  const res = await ghApi(`${contentsUrl()}?ref=${encodeURIComponent(cfg.branch)}`);
  if (res.status === 404) return { exists: false, sha: '', text: '' };
  if (!res.ok) throw new Error('读取失败：' + (await ghError(res)));
  const j = await res.json();
  if (j.content) return { exists: true, sha: j.sha, text: b64decodeUtf8(j.content) };
  // 文件大于 1 MB 时 GitHub 不给 content，得单独下 raw
  const raw = await fetch(j.download_url, { cache: 'no-cache' });
  if (!raw.ok) throw new Error('读取失败：文件较大，回源 raw 也失败 HTTP ' + raw.status);
  return { exists: true, sha: j.sha, text: await raw.text() };
}

async function writeRemote(text, message) {
  const body = { message, content: b64encodeUtf8(text), branch: cfg.branch };
  if (remoteSha) body.sha = remoteSha;
  const res = await ghApi(contentsUrl(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await ghError(res);
    if (res.status === 409 || res.status === 422) {
      throw new Error(`提交被拒（${err}）：这个文件刚在别处被改过。请先点「测试连接并读取」把最新内容拉下来合并，再提交 —— 直接重试会覆盖别人的改动。`);
    }
    throw new Error('提交失败：' + err);
  }
  return res.json();
}

// ---------------------------------------------------------------- 列表读写

/** 把仓库里的文件文本解析成 {extra, list}，解析失败时明确指出毛病在哪。 */
function parseFile(text) {
  if (!text.trim()) return { extra: {}, list: [] };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error('仓库里的公告文件不是合法 JSON：' + e.message + '（先手工修好再发布）');
  }
  const raw = Array.isArray(obj) ? obj : Array.isArray(obj?.announcements) ? obj.announcements : [];
  const extra = Array.isArray(obj) ? {} : Object.fromEntries(
    Object.entries(obj).filter(([k]) => k !== 'announcements' && k !== '_说明'),
  );
  const note = Array.isArray(obj) ? undefined : obj._说明;
  if (note !== undefined) extra._说明 = note;
  return { extra, list: raw };
}

/** 生成要提交的文件文本：保留 _说明 与其它顶层字段，只替换 announcements。 */
function serializeFile() {
  const obj = { ...remoteExtra, announcements: list };
  // _说明 放最前面，方便直接在 GitHub 网页上改的人先看到说明
  const ordered = {};
  if (obj._说明 !== undefined) ordered._说明 = obj._说明;
  for (const [k, v] of Object.entries(obj)) if (k !== '_说明') ordered[k] = v;
  return JSON.stringify(ordered, null, 2) + '\n';
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let id = `ann-${stamp}`;
  let n = 2;
  const taken = new Set(list.map((a) => String(a.id)));
  while (taken.has(id)) id = `ann-${stamp}-${n++}`;
  return id;
}

// ---------------------------------------------------------------- 渲染

// ---------------------------------------------------------------- 草稿

/**
 * 正在编辑的列表只存在内存里 —— 一刷新页面、或者去点「测试连接并读取」，
 * 刚写好的公告就没了。2026-10-18 因此连着提交了两次「更新 0 条」的空提交，
 * 公告没发出去、门铃也没响。所以每次重画列表都顺手落一份到本机。
 */
const LS_DRAFT = 'yangshan-admin/draft/v1';

function saveDraft() {
  try {
    localStorage.setItem(LS_DRAFT, JSON.stringify({ list, at: new Date().toISOString() }));
  } catch {
    /* 存不下不影响发布 */
  }
}

function restoreDraft() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(LS_DRAFT) || 'null');
  } catch {
    return;
  }
  if (!saved || !Array.isArray(saved.list) || !saved.list.length) return;
  list = saved.list;
  setHint('pubHint', `已恢复上次没发布的草稿（${list.length} 条）—— 确认无误后点「发布到仓库」。`, 'ok');
}

function renderList() {
  const box = $id('list');
  box.replaceChildren();
  $id('listCount').textContent = list.length ? `共 ${list.length} 条` : '';

  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '还没有公告。用上面的表单写一条，或者点「测试连接并读取」把仓库里已有的拉下来。';
    box.append(d);
    return;
  }

  list.forEach((a, i) => {
    const item = document.createElement('div');
    item.className = `ad-item lv-${['info', 'warn', 'urgent'].includes(a.level) ? a.level : 'info'}`;

    const t = document.createElement('div');
    t.className = 't';
    if (a.pinned) {
      const tag = document.createElement('span');
      tag.className = 'tag pin';
      tag.textContent = '置顶';
      t.append(tag);
    }
    const b = document.createElement('b');
    b.textContent = a.title || '（无标题）';
    const catTag = document.createElement('span');
    catTag.className = 'tag cat';
    catTag.textContent = a.category || CATEGORIES[0];
    const time = document.createElement('time');
    time.textContent = a.date || '';
    const idTag = document.createElement('span');
    idTag.className = 'tag';
    idTag.textContent = String(a.id ?? '');
    t.append(b, catTag, time, idTag);

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = a.body || '';

    const ops = document.createElement('div');
    ops.className = 'ops';
    const mk = (label, fn) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', fn);
      return btn;
    };
    ops.append(
      mk('编辑', () => startEdit(i)),
      mk('删除', () => {
        if (!confirm(`删除「${a.title || '（无标题）'}」？改完还要点「发布到仓库」才会生效。`)) return;
        list.splice(i, 1);
        if (editingIdx === i) resetForm();
        renderList();
      }),
      mk('上移', () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; renderList(); } }),
      mk('下移', () => { if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; renderList(); } }),
    );

    item.append(t, body, ops);
    box.append(item);
  });
  saveDraft();
}

// ---------------------------------------------------------------- 表单

function resetForm() {
  editingIdx = -1;
  $id('fTitle').value = '';
  $id('fDate').value = new Date().toISOString().slice(0, 10);
  $id('fCategory').value = CATEGORIES[0];
  $id('fLevel').value = 'info';
  $id('fLink').value = '';
  $id('fPinned').checked = false;
  $id('fBody').value = '';
  $id('btnAdd').textContent = '加入列表';
}

function startEdit(i) {
  const a = list[i];
  editingIdx = i;
  $id('fTitle').value = a.title ?? '';
  $id('fDate').value = a.date ?? '';
  $id('fCategory').value = CATEGORIES.includes(a.category) ? a.category : CATEGORIES[0];
  $id('fLevel').value = ['info', 'warn', 'urgent'].includes(a.level) ? a.level : 'info';
  $id('fLink').value = a.link ?? '';
  $id('fPinned').checked = Boolean(a.pinned);
  $id('fBody').value = a.body ?? '';
  $id('btnAdd').textContent = '保存修改';
  $id('fTitle').focus();
  window.scrollTo({ top: $id('fTitle').getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
}

function commitForm() {
  const title = $id('fTitle').value.trim();
  const body = $id('fBody').value.trim();
  if (!title && !body) {
    setHint('pubHint', '标题和正文至少要有一个 —— 两个都空的公告在应用里会被丢掉。', 'bad');
    return false;
  }
  const patch = {
    title,
    date: $id('fDate').value || new Date().toISOString().slice(0, 10),
    category: $id('fCategory').value,
    level: $id('fLevel').value,
    link: $id('fLink').value.trim(),
    pinned: $id('fPinned').checked,
    body,
  };

  if (editingIdx >= 0) {
    patch.id = list[editingIdx].id; // ★ 沿用原 id：同学那边不会重复提醒
    list[editingIdx] = { ...list[editingIdx], ...patch };
    setHint('pubHint', '已修改列表里的这一条（还没提交）。', 'ok');
  } else {
    list.unshift({ id: newId(), ...patch });
    setHint('pubHint', `已加入列表，新 id = ${list[0].id}。点「发布到仓库」才会生效。`, 'ok');
  }
  resetForm();
  renderList();
  return true;
}

// ---------------------------------------------------------------- 发布

async function doPublish() {
  readCfgInputs();
  if (!cfg.token) return setHint('pubHint', '先填 GitHub 令牌。', 'bad');
  // 表单里还有内容 ⇒ 这条还没进列表（commitForm 成功后会把表单清空）。
  // 以前这里直接提交 list，用户写完不点「加入列表」就发布，会提交一条「更新 0 条」的空提交，
  // 而且因为 list 为空连门铃都不发 —— 表现就是「公告发了但手机没收到」。现在自动补上这一步。
  if ($id('fTitle').value.trim() || $id('fBody').value.trim()) {
    if (!commitForm()) return; // 校验没过，原因已经写进提示里
  }
  if (!list.length) {
    return setHint('pubHint', '列表里一条公告都没有，没什么可发布的 —— 先在上面写一条。', 'bad');
  }
  const btn = $id('btnPublish');
  btn.disabled = true;
  setHint('pubHint', '正在提交…');
  try {
    const text = serializeFile();
    const r = await writeRemote(text, `公告：更新 ${list.length} 条（仰山课表管理页）`);
    remoteSha = r?.content?.sha || remoteSha;
    const note = list.length ? `已提交 ${list.length} 条公告。` : '已提交（公告列表为空）。';
    setHint('pubHint', `${note}GitHub Pages 一般 1 分钟内生效。`, 'ok');
    // 提交成功顺手发个门铃，同学那边不用等轮询
    if (cfg.topic && list.length) {
      try {
        await pushNotify();
        setHint('pubHint', `${note}门铃已发出，GitHub Pages 一般 1 分钟内生效。`, 'ok');
      } catch (e) {
        setHint('pubHint', `${note}但推送失败（${e.message}）—— 不影响公告本身，同学打开应用仍能看到。`, '');
      }
    } else if (!cfg.topic) {
      setHint('pubHint', `${note}但没有设推送频道 —— 同学不会收到提醒，得等他们自己打开应用才看得到。`, '');
    }
  } catch (e) {
    setHint('pubHint', e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
}

/**
 * 敲一声门铃。
 *
 * ★ 刻意**不带公告内容**，连标题都不带 —— 两个原因，都是实测出来的：
 *   1. ntfy.sh 是公共实例，「知道频道名就能往频道发消息」。内容一旦进了推送，
 *      就绕过了「公告只能来自 announcements.json」这条唯一的保证；
 *   2. HTTP 头只能放 ASCII，中文标题会被浏览器直接拒掉
 *      （Cannot convert argument to a ByteString...）。ntfy 官方支持 RFC 2047
 *      编码，但那又要把标题塞进推送里，与第 1 条冲突。
 *
 * 应用收到门铃只会做一件事：重新拉一次 announcements.json。所以这里发什么都不重要，
 * 用一个固定的 ASCII 串就够了（顺带让 ntfy 自己的界面里看得出是条消息）。
 *
 * 注意 ntfy 的 SSE 里，真正的消息是**裸 data: 行**（没有 event: 字段），
 * 而连接建立才有 `event: open` —— 所以应用端用 addEventListener('message') 才是对的。
 */
async function pushNotify() {
  if (!cfg.topic) throw new Error('还没设推送频道');
  const res = await fetch(ntfyPublishUrl(cfg.topic), {
    method: 'PUT',
    headers: { Priority: '3', Tags: 'loudspeaker' }, // 全是 ASCII
    body: 'new',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json().catch(() => null);
}

async function doTestPush() {
  readCfgInputs();
  const btn = $id('btnTestPush');
  btn.disabled = true;
  setHint('shareHint', '正在发…');
  try {
    await pushNotify();
    setHint('shareHint', '门铃已发出。手机端要把应用开着（或用安卓壳）才会立刻弹出来。', 'ok');
  } catch (e) {
    setHint('shareHint', '推送失败：' + e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- 连接测试

async function doTest() {
  readCfgInputs();
  const btn = $id('btnTest');
  btn.disabled = true;
  setHint('connHint', '正在读取…');
  try {
    const r = await readRemote();
    remoteSha = r.sha;
    if (!r.exists) {
      list = [];
      remoteExtra = {};
      setHint('connHint', `仓库里还没有 ${cfg.path} —— 第一次「发布」会自动创建它。`, 'ok');
    } else {
      const parsed = parseFile(r.text);
      // 不直接覆盖本地列表：刚写好还没发布的公告不能被一次「读取」冲掉
      const remote = parsed.list;
      const remoteIds = new Set(remote.map((a) => String(a.id)));
      const localOnly = list.filter((a) => !remoteIds.has(String(a.id)));
      list = [...localOnly, ...remote];
      remoteExtra = parsed.extra;
      setHint('connHint', localOnly.length
        ? `连接正常，读到 ${remote.length} 条公告；本机还有 ${localOnly.length} 条没提交，已一并留在下面。`
        : `连接正常，读到 ${remote.length} 条公告。`, 'ok');
    }
    renderList();
  } catch (e) {
    setHint('connHint', e.message, 'bad');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- 分享码

/** 公告文件在站点上的地址（构建时会把 data/announcements.json 复制到站点 /data/ 下）。 */
function annUrlOnSite() {
  if (!location.protocol.startsWith('http')) return '';
  return new URL('../data/announcements.json', location.href).href;
}

function renderShare() {
  const url = annUrlOnSite();
  if (!url) {
    $id('shareCode').value = '';
    setHint('shareHint', '这个页面是用 file:// 打开的，算不出站点地址。部署到 GitHub Pages 后再来看这段。', 'bad');
    return;
  }
  if (!cfg.topic) {
    $id('shareCode').value = '';
    setHint('shareHint', '先填一个推送频道（或点「换一个随机频道」）。', 'bad');
    return;
  }
  $id('shareCode').value = encodeAnnConfig({ url, topic: cfg.topic, name: '仰山课表公告' });
  setHint('shareHint', `公告地址：${url}`);
}

// ---------------------------------------------------------------- 绑定

function bind() {
  $id('btnTest').addEventListener('click', doTest);
  $id('btnForget').addEventListener('click', () => {
    if (!confirm('清除本机保存的令牌？之后要重新粘贴。')) return;
    cfg.token = '';
    $id('cfgToken').value = '';
    saveCfg();
    setHint('connHint', '令牌已清除。', 'ok');
  });
  $id('btnAdd').addEventListener('click', commitForm);
  $id('btnReset').addEventListener('click', () => { resetForm(); setHint('pubHint', ''); });
  $id('btnPublish').addEventListener('click', doPublish);
  $id('btnNotify').addEventListener('click', doTestPush);

  $id('btnTopic').addEventListener('click', () => {
    $id('cfgTopic').value = randomTopic('ys-bistu');
    readCfgInputs();
    renderShare();
    setHint('shareHint', '已换新频道 —— 记得把新的分享码重新发到班里；旧频道里的同学会收不到推送（但公告照样能刷到）。', 'ok');
  });
  $id('btnTestPush').addEventListener('click', doTestPush);
  $id('btnCopyCode').addEventListener('click', async () => {
    const code = $id('shareCode').value;
    if (!code) return setHint('shareHint', '还没有分享码。', 'bad');
    try {
      await navigator.clipboard.writeText(code);
      setHint('shareHint', '分享码已复制，发到班级群里就行。', 'ok');
    } catch {
      $id('shareCode').select();
      setHint('shareHint', '浏览器不让自动复制，已帮你全选，按 Ctrl+C 吧。', '');
    }
  });

  $id('btnCopyJson').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(serializeFile());
      setHint('pubHint', 'JSON 已复制。到 GitHub 上打开该文件 → 编辑 → 全选粘贴 → 提交。', 'ok');
    } catch {
      setHint('pubHint', '浏览器不让自动复制，请用「下载 JSON」。', 'bad');
    }
  });
  $id('btnDownloadJson').addEventListener('click', () => {
    const blob = new Blob([serializeFile()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'announcements.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  for (const id of ['cfgRepo', 'cfgBranch', 'cfgPath', 'cfgToken', 'cfgTopic']) {
    $id(id).addEventListener('change', () => {
      readCfgInputs();
      $id('manualPath').textContent = cfg.path;
      renderShare();
    });
  }
}

// ---------------------------------------------------------------- 启动

loadCfg();
fillCfgInputs();
bind();
resetForm();
restoreDraft();
renderShare();
renderList();
setHint('connHint', cfg.token ? '已从本机读到令牌。点「测试连接并读取」验证一下。' : '填好仓库和令牌，然后点「测试连接并读取」。');
