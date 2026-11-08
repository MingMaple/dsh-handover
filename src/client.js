/**
 * dsh-handover 浏览器半：在「设置 → 交接」注册一个只读状态页。
 * 手工构建的 DSH client bundle（不用 JSX/打包器）：只 require react，
 * 数据来自宿主侧注册的 GET /dsh-handover/status.json（只读、不唤醒任何会话）。
 *
 * 改了这个文件要重建 dist 并在 DSH 里重新激活插件（client bundle 不热更）。
 */
window.__ModuleLoader__.load({
  id: '@mingmaple/dsh-handover',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;
    /** 参与槽位注册的服务；connection＝DSH 认证的 /api 载体（设置页取数的主通道）。 */
    const inject = ["slots", "connection"];
    let connection = null;

    /** 数据接口候选：绝对路径优先，再退相对（页面挂在子路径时仍能取到）。 */
    const ENDPOINTS = ["/dsh-handover/status.json", "dsh-handover/status.json"];

    const CSS_TAG_ID = "@mingmaple/dsh-handover/SettingsSection.css";
    const CSS = [
      ".dshh-root{display:flex;flex-direction:column;gap:14px;max-width:860px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}",
      ".dshh-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".dshh-title{margin:0;font-size:16px;font-weight:600}",
      ".dshh-muted{color:var(--dsw-alias-label-tertiary)}",
      ".dshh-btn{font:inherit;cursor:pointer;background:0 0;color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 10px}",
      ".dshh-btn:disabled{opacity:.5;cursor:default}",
      ".dshh-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}",
      ".dshh-cardTitle{margin:0;font-weight:600;font-size:13px}",
      ".dshh-grid{display:grid;grid-template-columns:auto 1fr;gap:4px 14px}",
      ".dshh-k{color:var(--dsw-alias-label-tertiary)}",
      ".dshh-table{width:100%;border-collapse:collapse;table-layout:fixed}",
      ".dshh-table th,.dshh-table td{text-align:left;padding:3px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;white-space:normal;overflow-wrap:anywhere;vertical-align:middle}",
      ".dshh-table th{white-space:nowrap;font-weight:600}",
      ".dshh-num{white-space:nowrap}",
      ".dshh-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}",
      ".dshh-pick{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".dshh-inputSm{font:inherit;font-size:12px;padding:2px 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;color:var(--dsw-alias-label-primary);box-sizing:border-box;width:100%}",
      ".dshh-ok{color:var(--dsw-alias-state-business-primary,#1a7f37)}",
      ".dshh-bad{color:var(--dsw-alias-state-error-primary,#c62828)}",
      ".dshh-warn{color:var(--dsw-alias-state-warning-primary,#b26a00)}",
      ".dshh-list{margin:0;padding-left:18px}",
      ".dshh-sub{margin:6px 0 2px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".dshh-sum{cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px}",
      ".dshh-wrap td{white-space:normal}",
      ".dshh-input{font:inherit;width:100%;box-sizing:border-box;padding:5px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;color:var(--dsw-alias-label-primary)}",
      ".dshh-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:2px}",
      ".dshh-textarea{font:inherit;width:100%;box-sizing:border-box;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;color:var(--dsw-alias-label-primary);resize:vertical}",
      ".dshh-code{font-family:ui-monospace,Consolas,monospace;font-size:12px}",
    ].join("");

    /** 注入样式（按 tagId 去重，插件重复激活时不会堆叠）。 */
    function installCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') !== null) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "@mingmaple/dsh-handover";
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** 依次尝试候选地址取状态；全失败时抛出带全部原因的错。 */
    /** 带超时的 fetch（旧通道回退用；没有超时就会永远「读取中」）。 */
    async function fetchWithTimeout(url, opts, ms) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), ms || 8000);
      try {
        return await fetch(url, Object.assign({ signal: ac.signal }, opts || {}));
      } finally {
        clearTimeout(timer);
      }
    }

    async function fetchStatus() {
      const reasons = [];
      for (const url of ENDPOINTS) {
        try {
          const res = await fetchWithTimeout(url, { cache: "no-store", headers: { accept: "application/json" } }, 30000);
          if (!res.ok) { reasons.push(url + " → HTTP " + res.status); continue; }
          return await res.json();
        } catch (e) {
          reasons.push(url + " → " + (e && e.message ? e.message : String(e)));
        }
      }
      throw new Error(reasons.join("；") || "无法取得状态");
    }

    /** 通道诊断（显示于页面；出现异常时可直接定位，无需推测）。 */
    const diag = { lastError: "" };

    /** 页面级快照缓存：设置页切走再切回时先渲染旧读数，再后台刷新（不出现「正在读取」）。 */
    const state = { last: null };

    /** 读数时间保留完整值（含年份与时区），与页头一致。 */
    function shortTime(s) {
      return String(s || "");
    }

    /** 会话短号：去掉 session- 前缀，留前 8 位。 */
    function shortSid(s) {
      return String(s || "").replace(/^session-/, "").slice(0, 8);
    }

    /**
     * 可折叠表格：先显示 pageSize 行，点「再展开」继续加 pageSize 行。
     * 列宽由 widths 百分比给定（表头固定、不横向滚动）。
     */
    function Folded(props) {
      const rows = props.rows || [];
      const size = props.pageSize || 5;
      const [shown, setShown] = React.useState(size);
      const visible = rows.slice(0, shown);
      const rest = rows.length - visible.length;
      const more = rest > 0
        ? h("button", { className: "dshh-btn", type: "button", onClick: () => setShown(shown + size) }, "再展开 " + Math.min(size, rest) + " 个")
        : null;
      const fold = shown > size
        ? h("button", { className: "dshh-btn", type: "button", onClick: () => setShown(size) }, "收起")
        : null;
      return h(React.Fragment, null,
        h("table", { className: "dshh-table" },
          h("colgroup", null, (props.widths || []).map((w, i) => h("col", { key: i, style: { width: w } }))),
          h("thead", null, h("tr", null, (props.cols || []).map((c, i) => h("th", { key: i }, c)))),
          h("tbody", null, visible.map((r, i) => props.render(r, i)))),
        rows.length > size
          ? h("div", { className: "dshh-foot" },
            h("span", { className: "dshh-muted" }, "共 " + rows.length + " 个，已显示 " + visible.length + " 个"),
            more, fold)
          : null);
    }

    function carrierKind() {
      const conn = connection;
      if (!conn) return "无 connection";
      if (!conn.rpc) return "无 connection.rpc";
      if (typeof conn.rpc.call !== "function") return "无 rpc.call";
      return "可用（参数 " + (conn.rpc.call.length || "?") + "）";
    }

    /** 与超时赛跑：宿主 rpc.call 不理会 AbortSignal，光 abort 会让页面永远「读取中」。 */
    function raceTimeout(promise, ms, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(label + " 超时 " + ms + " ms")), ms);
        Promise.resolve(promise).then(
          (v) => { clearTimeout(timer); resolve(v); },
          (e) => { clearTimeout(timer); reject(e); },
        );
      });
    }

    /** 主通道：DSH 认证的 /api 载体（宿主 registerRpcCarrier 注册）。 */
    async function rpc(method, payload, ms) {
      const conn = connection;
      // 必须保留 this=connection.rpc：宿主用 this 拼目标，换成别的对象会得到
      // "[object Object]/api" 并报 invalid RPC target。
      const rpcObj = conn && conn.rpc && typeof conn.rpc.call === "function" ? conn.rpc : null;
      if (!rpcObj) throw new Error("宿主没有 connection.rpc（载体=" + carrierKind() + "）");
      // 不用 AbortController 主动中止：宿主处理可能超过 8 秒，只做与超时赛跑，
      // 让请求在宿主侧自然完成，慢一点也能拿到结果。
      const ac = new AbortController();
      const limit = ms || 30000;
      const t0 = Date.now();
      try {
        // 签名（与 dsh-im 一致）：connection.rpc.call(target, endpoint, call, signal)，且 this 必须是 connection.rpc。
        let r;
        try {
          r = await raceTimeout(
            rpcObj.call("/api", "dsh-handover", { method: method, payload: payload || {} }, ac.signal),
            limit + 500,
            "载体",
          );
        } catch (e) {
          if (!/invalid RPC target/i.test(String(e && e.message ? e.message : e))) throw e;
          // 退一步：有的宿主把 target 预置在 rpc 上，只收 (endpoint, call, signal)
          r = await raceTimeout(
            rpcObj.call("dsh-handover", { method: method, payload: payload || {} }, ac.signal),
            limit + 500,
            "载体",
          );
        }
        if (!r || r.ok !== true) {
          const err = (r && r.error) || {};
          throw new Error(String(err.message || "载体返回失败"));
        }
        return r.value;
      } catch (e) {
        diag.lastError = "载体：" + String(e && e.message ? e.message : e) + "（耗时 " + (Date.now() - t0) + " ms）";
        throw e;
      }
    }

    /** 写操作：先载体，失败再退 HTTP；成功统一补 ok:true，失败抛错。 */
    async function post(method, payload, ms) {
      try {
        const v = await rpc(method, payload, ms || 20000);
        return Object.assign({ ok: true }, v && typeof v === "object" ? v : { value: v });
      } catch (e1) {
        try {
          const b = await postJson("/dsh-handover/" + method, payload);
          return Object.assign({ ok: true }, b && typeof b === "object" ? b : { value: b });
        } catch (e2) {
          throw new Error(String(e1 && e1.message ? e1.message : e1) + "（HTTP 回退也失败：" + String(e2 && e2.message ? e2.message : e2) + "）");
        }
      }
    }

    /** POST JSON：同样先绝对路径再相对路径。 */
    async function postJson(pathname, payload) {
      const reasons = [];
      for (const base of ["", "."]) {
        const url = base + pathname;
        try {
          const res = await fetchWithTimeout(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}) }, 15000);
          let body = null;
          try { body = await res.json(); } catch (e) { body = null; }
          if (body) return body;
          reasons.push(url + " → HTTP " + res.status);
        } catch (e) {
          reasons.push(url + " → " + (e && e.message ? e.message : String(e)));
        }
      }
      throw new Error(reasons.join("；"));
    }

    function card(title, children) {
      return h("section", { className: "dshh-card" }, h("h3", { className: "dshh-cardTitle" }, title), children);
    }

    function kv(rows) {
      const kids = [];
      rows.forEach((r, i) => {
        kids.push(h("div", { className: "dshh-k", key: "k" + i }, r[0]));
        kids.push(h("div", { key: "v" + i }, r[1]));
      });
      return h("div", { className: "dshh-grid" }, kids);
    }

    function verdict(el, ok) {
      return h("span", { className: ok ? "dshh-ok" : "dshh-bad" }, el);
    }

    function fmtBytes(n) {
      const v = Number(n) || 0;
      if (v >= 1024 * 1024 * 1024) return (v / (1024 * 1024 * 1024)).toFixed(2) + " GB";
      if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + " MB";
      if (v >= 1024) return (v / 1024).toFixed(1) + " KB";
      return v + " B";
    }

    /** 设置页正身：只读，一个刷新按钮。 */
    function HandoverSection() {
      // 首屏直接用上一次的读数（切走再切回不再出现「正在读取」），后台再刷新。
      const [data, setData] = React.useState(state.last);
      const [err, setErr] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      // 首次安装向导
      const [parent, setParent] = React.useState("");
      const [created, setCreated] = React.useState("");
      const [setupMsg, setSetupMsg] = React.useState("");
      const [setupBad, setSetupBad] = React.useState(false);
      const [working, setWorking] = React.useState(false);
      // 追加系统提示词
      const [extra, setExtra] = React.useState("");
      const [extraMsg, setExtraMsg] = React.useState("");
      const [extraBad, setExtraBad] = React.useState(false);
      const [channel, setChannel] = React.useState("");
      // 搬迁：探针 / 复制 / 状态
      const [mvTo, setMvTo] = React.useState("");
      const [mvBusy, setMvBusy] = React.useState(false);
      const [mvMsg, setMvMsg] = React.useState("");
      const [mvBad, setMvBad] = React.useState(false);
      const [mvProbe, setMvProbe] = React.useState(null);
      const [mvStatus, setMvStatus] = React.useState(null);
      // 删除旧副本的确认词。
      const [delWord, setDelWord] = React.useState("");

      const load = React.useCallback(() => {
        if (state.last) setData(state.last);
        setBusy(true);
        setErr("");
        (async () => {
          let d = null;
          let via = "";
          try {
            d = await rpc("status", {}, 30000);
            via = "载体（/api）";
          } catch (e1) {
            try {
              d = await fetchStatus();
              via = "HTTP 回退";
            } catch (e2) {
              const msg = "载体（" + carrierKind() + "）：" + String(e1 && e1.message ? e1.message : e1)
                + "；HTTP 回退：" + String(e2 && e2.message ? e2.message : e2);
              diag.lastError = msg;
              setErr(msg);
              setBusy(false);
              return;
            }
          }
          state.last = d;
          setData(d);
          setChannel(via);
          setExtra(typeof d.extraPrompt === "string" ? d.extraPrompt : "");
          try { setMvStatus(await rpc("move.status", {}, 8000)); } catch (e) { setMvStatus(null); }
          setBusy(false);
        })();
      }, []);

      const buildTree = React.useCallback(() => {
        setWorking(true); setSetupBad(false); setSetupMsg("");
        post("setup", { parent: parent }, 120000)
          .then((r) => {
            if (r && r.ok) {
              setCreated(r.root || "");
              setSetupMsg("已建立：目录 " + (r.created || []).length + " 个、文件 " + (r.written || []).length + " 个。下一步：注册为工作区。");
            } else {
              setSetupBad(true);
              setSetupMsg((r && r.error) || "建立失败");
            }
          })
          .catch((e) => { setSetupBad(true); setSetupMsg("请求未完成：" + (e && e.message ? e.message : String(e))); })
          .then(() => setWorking(false));
      }, [parent]);

      const registerWs = React.useCallback(() => {
        if (!created) return;
        setWorking(true); setSetupBad(false); setSetupMsg("");
        post("register", { path: created, title: "全局" }, 20000)
          .then((r) => {
            if (r && r.ok) setSetupMsg("已注册工作区：" + (r.title || "全局") + "（" + (r.id || "?") + "）。新建一个标题含「全局」的会话即可接入。");
            else { setSetupBad(true); setSetupMsg(((r && r.error) || "注册失败") + (r && r.hint ? "；" + r.hint : "")); }
          })
          .catch((e) => { setSetupBad(true); setSetupMsg("请求未完成：" + (e && e.message ? e.message : String(e))); })
          .then(() => setWorking(false));
      }, [created]);

      const saveExtra = React.useCallback(() => {
        setWorking(true); setExtraBad(false); setExtraMsg("");
        post("extra-prompt", { text: extra }, 20000)
          .then((r) => {
            if (r && r.ok) {
              if (r.unchanged) setExtraMsg(r.note || "内容未变，已跳过写入。");
              else setExtraMsg((r.chars ? "已保存，共 " + r.chars + " 字符，位置在工具说明之前。" : "已清空，不再注册提示段。") + (r.cacheNote ? " " + r.cacheNote : ""));
            }
            else { setExtraBad(true); setExtraMsg((r && r.error) || "保存失败"); }
          })
          .catch((e) => { setExtraBad(true); setExtraMsg("请求未完成：" + (e && e.message ? e.message : String(e))); })
          .then(() => setWorking(false));
      }, [extra]);

      // 会话角色
      const [roleSel, setRoleSel] = React.useState({});
      const [roleStage, setRoleStage] = React.useState({});
      const [roleMsg, setRoleMsg] = React.useState("");
      const [roleBad, setRoleBad] = React.useState(false);

      const setRoleValue = React.useCallback((sid, patch) => {
        setRoleSel((prev) => {
          const next = Object.assign({}, prev || {});
          next[sid] = Object.assign({}, next[sid] || {}, patch);
          return next;
        });
        // 改了角色就回到第一步，按钮重新显示「设置角色」。
        setRoleStage((prev) => {
          const next = Object.assign({}, prev || {});
          next[sid] = "";
          return next;
        });
      }, []);

      const submitRole = React.useCallback((sid, role, project, task, wake) => {
        setWorking(true); setRoleBad(false); setRoleMsg("");
        post("role", { session_id: sid, role: role, project: project, task: task, wake: wake }, 30000)
          .then((r) => {
            if (r && r.ok) {
              const liveText = r.live ? "已在当前会话生效" : "自下一轮起生效";
              const sendText = wake
                ? (r.delivered ? "整理指令已送达，该会话将被唤醒一轮" : ("整理指令未送达" + (r.error ? "：" + r.error : "")))
                : "";
              setRoleMsg("角色已设为" + (r.role || role) + "，" + liveText + (sendText ? "；" + sendText : "。"));
              setRoleStage((prev) => {
                const next = Object.assign({}, prev || {});
                next[sid] = wake ? "notified" : "set";
                return next;
              });
              load();
            } else {
              setRoleBad(true);
              setRoleMsg((r && r.error) || "设置失败");
            }
          })
          .catch((e) => { setRoleBad(true); setRoleMsg("请求未完成：" + (e && e.message ? e.message : String(e))); })
          .then(() => setWorking(false));
      }, [load]);

      // 搬迁：探针 → 复制并校验 → 状态 → 清旧副本
      const refreshMove = React.useCallback(() => {
        rpc("move.status", {}, 10000).then((st) => setMvStatus(st)).catch(() => {});
      }, []);

      const callMove = React.useCallback((method, payload, ms) => {
        setMvBusy(true); setMvBad(false); setMvMsg("");
        return rpc(method, payload, ms || 20000)
          .then((v) => v)
          .catch((e) => { setMvBad(true); setMvMsg(String(e && e.message ? e.message : e)); throw e; })
          .then((v) => v, () => null)
          .then((v) => { setMvBusy(false); return v; });
      }, []);

      const doProbe = React.useCallback(() => {
        callMove("move.probe", { to: mvTo }, 90000).then((p) => {
          if (!p) return;
          setMvProbe(p);
          setMvBad(!p.ok);
          setMvMsg(p.ok ? "预检通过，可以开始复制。" : "预检未通过，原因见下。");
        });
      }, [mvTo, callMove]);

      const doCopy = React.useCallback(() => {
        callMove("move.start", { to: mvTo }, 900000).then((r) => {
          if (!r) return;
          setMvBad(false);
          setMvMsg("复制与校验通过：共 " + r.report.files + " 个文件、" + fmtBytes(r.report.bytes) + "。切换脚本已生成。");
          refreshMove();
        });
      }, [mvTo, callMove, refreshMove]);

      const doSwitch = React.useCallback(() => {
        callMove("move.switch", {}, 30000).then((r) => {
          if (!r) return;
          setMvBad(false);
          setMvMsg(r.already
            ? "当前已处于切换完成状态（原路径为链接），无需再次切换。"
            : "已就绪：请完全退出 DSH，退出后约 1 秒完成切换，等待 10 秒后再打开。日志：" + (r.log || ""));
          refreshMove();
        });
      }, [callMove, refreshMove]);

      // 压缩授权：只有用户在这里点一下，压缩才排得进去（AI 不能自己批）
      const [csSid, setCsSid] = React.useState("");
      const [csMsg, setCsMsg] = React.useState("");
      const doGrant = React.useCallback(() => {
        setWorking(true); setCsMsg("");
        post("consent.grant", { session_id: csSid }, 15000)
          .then((r) => {
            if (r && r.ok) { setCsMsg("已授权会话 " + r.sessionId + "，5 分钟内可压缩一次，用后失效。"); load(); }
            else setCsMsg("授权未完成：" + ((r && r.error) || "原因未知"));
          })
          .catch((e) => setCsMsg("请求未完成：" + (e && e.message ? e.message : String(e))))
          .then(() => setWorking(false));
      }, [csSid, load]);
      const doGrantSid = React.useCallback((sid) => {
        setWorking(true); setCsMsg("");
        post("consent.grant", { session_id: sid }, 15000)
          .then((r) => {
            if (r && r.ok) { setCsMsg("已授权会话 " + r.sessionId + "，5 分钟内可压缩一次，用后失效。"); load(); }
            else setCsMsg("授权未完成：" + ((r && r.error) || "原因未知"));
          })
          .catch((e) => setCsMsg("请求未完成：" + (e && e.message ? e.message : String(e))))
          .then(() => setWorking(false));
      }, [load]);

      const doRevoke = React.useCallback((sid) => {
        setWorking(true); setCsMsg("");
        post("consent.revoke", { session_id: sid }, 15000)
          .then(() => { setCsMsg("已撤销 " + sid + " 的压缩授权。"); load(); })
          .catch(() => { /* 撤销失败不影响别的 */ })
          .then(() => setWorking(false));
      }, [load]);

      const doRetarget = React.useCallback(() => {
        callMove("move.retarget-stage", {}, 20000).then((r) => {
          if (!r) return;
          if (r.already) { setMvMsg("DSH 登记已在新位置，无需修改登记。"); return; }
          setMvBad(false);
          setMvMsg("已就绪：DSH 退出后改写登记，每份先备份，重启后生效。日志：" + ((r.script && r.script.log) || ""));
          refreshMove();
        });
      }, [callMove, refreshMove]);

      const doRepair = React.useCallback(() => {
        callMove("move.repair", {}, 20000).then((r) => {
          if (!r) return;
          setMvBad(false);
          setMvMsg(r.already ? "原路径已经是链接，无需重建。" : "已重建链接：" + r.src + " 现指向 " + r.dst + "（未改动任何文件）");
          refreshMove();
        });
      }, [callMove, refreshMove]);

      const doCleanup = React.useCallback(() => {
        if (String(delWord || "").trim() !== "删除") {
          setMvBad(true);
          setMvMsg("确认词不正确。请输入「删除」两个字后再执行。");
          return;
        }
        callMove("move.cleanup", { confirm: true }, 180000).then((r) => {
          if (!r) return;
          setMvBad(false);
          setDelWord("");
          setMvMsg(r.note + ((r.removed || []).length ? "：" + r.removed.join("、") : ""));
          refreshMove();
        });
      }, [delWord, callMove, refreshMove]);

      // 有缓存时先出一帧旧读数，再拉新数据；没有缓存才等一次。
      React.useEffect(() => { installCss(); load(); }, []);

      const head = h("div", { className: "dshh-head" },
        h("h2", { className: "dshh-title" }, "dsh-handover"),
        h("button", { className: "dshh-btn", onClick: load, disabled: busy, type: "button" }, busy ? (data ? "正在刷新" : "正在读取") : "刷新"),
        h("span", { className: "dshh-muted" }, "数据通道 " + (channel || carrierKind()) + (diag.lastError ? "；上次失败 " + diag.lastError.slice(0, 90) : "")),
        data ? h("span", { className: "dshh-muted" }, "读数时间 " + data.generatedAt) : null);

      if (err && !data) {
        return h("div", { className: "dshh-root" }, head,
          h("div", { className: "dshh-bad" }, "无法取得状态：" + err),
          h("div", { className: "dshh-muted" }, "若插件刚安装，请确认已在配置中启用本插件，并已重启 DSH。"));
      }
      if (!data) {
        return h("div", { className: "dshh-root" }, head, h("div", { className: "dshh-muted" }, "正在读取状态数据。"));
      }

      const p = data.plugin || {};
      const ws = data.workspace || {};
      const gate = data.gate;
      const ho = data.handover;
      const ss = data.sessions;
      const allSessions = (data.sessions && Array.isArray(data.sessions.all)) ? data.sessions.all : [];
      const byActivity = allSessions.slice().sort((a, b) => String(b.seen || "").localeCompare(String(a.seen || "")));

      // 排序原则：进来大概率要做的事在前，只读数据居中，说明文字最后。
      const sections = [];

      // 一、首次安装：仅在尚未接入工作区时出现，此时它是唯一可做的事。
      const setup = data.setup;
      const notReady = !ws || ws.found === false;
      if (setup && notReady && (setup.steps || []).length) {
        const msg = setupMsg ? h("div", { className: setupBad ? "dshh-bad" : "dshh-ok" }, setupMsg) : null;
        sections.push(card("首次安装",
          h("div", null,
            h("div", { className: "dshh-muted" }, "插件已加载，工具与本页可用；闸门、交接体检与会话水位在接入工作区后显示。"),
            h("ol", { className: "dshh-list" }, setup.steps.map((s, i) => h("li", { key: i }, s))),
            h("input", {
              className: "dshh-input",
              type: "text",
              value: parent,
              placeholder: "已存在目录的绝对路径，_Workspace 将建在其内",
              onChange: (e) => setParent(e.target.value),
            }),
            h("div", { className: "dshh-row" },
              h("button", { className: "dshh-btn", type: "button", disabled: working || !parent, onClick: buildTree }, working ? "正在建立" : "建立全局文件体系"),
              created ? h("button", { className: "dshh-btn", type: "button", disabled: working, onClick: registerWs }, "注册为工作区") : null),
            created ? h("div", { className: "dshh-code" }, created) : null,
            msg)));
      }

      // 二、压缩授权：唯一合法的「用户同意」入口，置顶。
      const consentRows = Array.isArray(data.consent) ? data.consent : [];
      sections.push(card("压缩授权",
        h("div", null,
          h("div", { className: "dshh-muted" }, "压缩须由你授权：点「允许」后，该会话可在 5 分钟内压缩一次，用后失效。也可在对话中发送 /allow-compact。"),
          h("div", { className: "dshh-pick" },
            byActivity.slice(0, 10).map((r, i) => h("button", {
              className: "dshh-btn",
              type: "button",
              key: i,
              disabled: working,
              title: r.title || r.sid,
              onClick: () => doGrantSid(r.sid),
            }, "允许 " + shortSid(r.sid)))),
          h("div", { className: "dshh-row" },
            h("input", {
              className: "dshh-inputSm",
              type: "text",
              value: csSid,
              placeholder: "或输入会话 id 或 8 位短号",
              onChange: (e) => setCsSid(e.target.value),
            }),
            h("button", { className: "dshh-btn", type: "button", disabled: working || !csSid, onClick: doGrant }, working ? "正在授权" : "授权")),
          consentRows.length
            ? h("table", { className: "dshh-table" },
              h("colgroup", null, h("col", { style: { width: "62%" } }), h("col", { style: { width: "18%" } }), h("col", { style: { width: "20%" } })),
              h("thead", null, h("tr", null, h("th", null, "已授权会话"), h("th", null, "剩余"), h("th", null, "操作"))),
              h("tbody", null, consentRows.map((r, i) => h("tr", { key: i },
                h("td", { className: "dshh-code", title: r.sessionId }, shortSid(r.sessionId)),
                h("td", { className: "dshh-num" }, Math.round((r.leftMs || 0) / 1000) + " 秒"),
                h("td", null, h("button", { className: "dshh-btn", type: "button", disabled: working, onClick: () => doRevoke(r.sessionId) }, "撤销"))))))
            : h("div", { className: "dshh-muted" }, "当前无有效授权。"),
          csMsg ? h("div", { className: "dshh-ok" }, csMsg) : null)));

      // 三、移动全局根目录：常态折叠为一行状态。
      {
        const st = mvStatus;
        const phaseLabel = {
          none: "尚无迁移记录",
          verified: "已复制并校验，等待切换",
          switched: "已切换，原路径为链接",
          "switched+cleaned": "已切换，旧副本已删除",
          partial: "校验有差异，需重新复制",
        };
        const attention = !!(st && (st.linkBroken || st.srcExists === false || st.phase === "verified" || st.phase === "partial" || (st.retarget && st.retarget.needed) || (st.phase === "switched" && (st.olds || []).length)));
        const stateText = st ? "状态：" + (phaseLabel[st.phase] || st.phase) + (st.dst ? "（" + st.dst + "）" : "") : "正在读取迁移状态";
        const kids = [];
        kids.push(h("div", { className: "dshh-muted" }, "复制并校验通过后才能切换；切换只改名与建立链接，不改动文件内容。"));
        if (st && st.phase && st.phase.indexOf("switched") === 0) {
          kids.push(h("div", { className: "dshh-muted" }, "原路径现为链接，请勿删除；若已删除，用「重建链接」恢复。"));
        }
        if (st && (st.srcExists === false || st.linkBroken)) {
          kids.push(h("div", { className: "dshh-bad" }, st.linkBroken
            ? "链接指向的新位置不存在：" + (st.dst || "") + "。请先确认真实数据位置；本页不改动文件。"
            : "原路径不存在（可能已被删除）：" + (st.src || "") + "。数据仍在 " + (st.dst || "") + "。"));
          if (st.canRepair) {
            kids.push(h("div", { className: "dshh-row" },
              h("button", { className: "dshh-btn", type: "button", disabled: mvBusy, onClick: doRepair }, "重建链接")));
          }
        }
        if (st && st.phase === "verified" && st.script) {
          kids.push(h("div", { className: "dshh-sub" }, "切换步骤"));
          kids.push(h("ol", { className: "dshh-list" },
            h("li", null, "点击「准备切换」，助手进入待命状态。"),
            h("li", null, "完全退出 DSH，含托盘与后台进程。"),
            h("li", null, "退出后自动执行，约 50 毫秒。"),
            h("li", null, "等待 10 秒后再打开 DSH。"),
            h("li", null, "回到本页，状态应为「已切换，原路径为链接」。")));
          kids.push(h("div", { className: "dshh-row" },
            h("button", { className: "dshh-btn", type: "button", disabled: mvBusy, onClick: doSwitch }, mvBusy ? "正在准备" : "准备切换（退出 DSH 后自动完成）")));
          kids.push(h("div", { className: "dshh-muted" }, "日志末行出现「切换完成」即为成功；失败会写明原因且不改动文件，可重试。助手未运行时手工执行：" + ((st.script && st.script.helper) || "")));
        }
        if (st && st.retarget && st.retarget.needed) {
          kids.push(h("div", { className: "dshh-warn" }, "DSH 登记仍指向旧路径：" + st.retarget.total + " 处，涉及 " + st.retarget.files.length + " 个文件。"));
          kids.push(h("div", { className: "dshh-muted" }, "退出 DSH 时改写，每份先备份；重启后生效。"));
          kids.push(h("div", { className: "dshh-row" },
            h("button", { className: "dshh-btn", type: "button", disabled: mvBusy, onClick: doRetarget }, "把登记迁到新位置（退出 DSH 后生效）")));
          for (const rf of (st.retarget.files || [])) {
            kids.push(h("div", { className: "dshh-code dshh-muted" }, rf.path + "  ×" + rf.count));
          }
        }
        if (st && st.retarget && st.retarget.needed === false) {
          kids.push(h("div", { className: "dshh-ok" }, "DSH 登记已指向新位置：" + (st.dst || "") + "。"));
        }
        if (st && st.phase === "switched" && (st.olds || []).length) {
          kids.push(h("div", { className: "dshh-muted" }, "旧副本：" + st.olds.map((o) => o.path + "（" + fmtBytes(o.bytes) + "）").join("、") + "。删除后无法恢复。"));
          kids.push(h("div", { className: "dshh-row" },
            h("input", {
              className: "dshh-inputSm",
              type: "text",
              value: delWord,
              placeholder: "输入「删除」以确认",
              onChange: (e) => setDelWord(e.target.value),
            }),
            h("button", { className: "dshh-btn", type: "button", disabled: mvBusy || delWord.trim() !== "删除", onClick: doCleanup }, "删除旧副本（不可撤销）")));
        }
        kids.push(h("div", { className: "dshh-row" },
          h("input", {
            className: "dshh-input",
            type: "text",
            value: mvTo,
            placeholder: "新根目录的绝对路径",
            onChange: (e) => setMvTo(e.target.value),
          })));
        kids.push(h("div", { className: "dshh-row" },
          h("button", { className: "dshh-btn", type: "button", disabled: mvBusy || !mvTo, onClick: doProbe }, mvBusy ? "正在预检" : "预检"),
          h("button", { className: "dshh-btn", type: "button", disabled: mvBusy || !mvTo, onClick: doCopy }, "复制并校验"),
          h("button", { className: "dshh-btn", type: "button", disabled: mvBusy, onClick: refreshMove }, "刷新状态")));
        if (mvProbe) {
          kids.push(kv([
            ["源", h("span", { className: "dshh-code" }, mvProbe.src)],
            ["目标", h("span", { className: "dshh-code" }, mvProbe.dst)],
            ["总大小", mvProbe.files + " 文件 · " + fmtBytes(mvProbe.bytes)],
            ["目标盘可用", mvProbe.freeBytes === null || mvProbe.freeBytes === undefined ? "?" : fmtBytes(mvProbe.freeBytes)],
            ["结论", mvProbe.ok ? verdict("通过", true) : verdict("不通过", false)],
          ]));
          for (const w of (mvProbe.warnings || [])) kids.push(h("div", { className: "dshh-warn" }, "注意：" + w));
          for (const x of (mvProbe.problems || [])) kids.push(h("div", { className: "dshh-bad" }, "未通过：" + x));
        }
        if (mvMsg) kids.push(h("div", { className: mvBad ? "dshh-bad" : "dshh-ok" }, mvMsg));
        sections.push(card("移动全局根目录",
          h("div", null,
            h("details", null,
              h("summary", { className: "dshh-sum" }, (attention ? "需要处理：" : "") + stateText),
              h("div", { className: "dshh-wrap" }, kids)))));
      }

      // 四、会话角色：角色列即当前值，设置成功后按钮切换为「通知该会话」。
      const roleRow = (r, i) => {
        const draft = (roleSel && roleSel[r.sid]) || {};
        const role = draft.role !== undefined ? draft.role : (r.role || "plain");
        const project = draft.project !== undefined ? draft.project : (r.project || "");
        const task = draft.task !== undefined ? draft.task : (r.task || "");
        const wide = role === "project" || role === "misc";
        const stage = (roleStage && roleStage[r.sid]) || "";
        const action = stage === "notified"
          ? h("button", { className: "dshh-btn", type: "button", disabled: true }, "已通知")
          : stage === "set"
            ? h("button", { className: "dshh-btn", type: "button", disabled: working, onClick: () => submitRole(r.sid, role, project, task, true) }, "通知该会话")
            : h("button", { className: "dshh-btn", type: "button", disabled: working, onClick: () => submitRole(r.sid, role, project, task, false) }, "设置角色");
        return h("tr", { key: i },
          h("td", null, r.title || "（无标题）"),
          h("td", { className: "dshh-code dshh-num" }, shortSid(r.sid)),
          h("td", { className: "dshh-num" }, r.pct === null || r.pct === undefined ? "?" : r.pct.toFixed(1) + "%"),
          h("td", null, h("select", {
            className: "dshh-inputSm",
            value: role,
            onChange: (e) => setRoleValue(r.sid, { role: e.target.value }),
          },
            h("option", { value: "plain" }, "普通"),
            h("option", { value: "global" }, "全局"),
            h("option", { value: "project" }, "项目"),
            h("option", { value: "misc" }, "杂项"))),
          h("td", null, wide ? h("input", {
            className: "dshh-inputSm",
            type: "text",
            value: role === "project" ? project : task,
            placeholder: role === "project" ? "填写项目名" : "填写任务名",
            onChange: (e) => setRoleValue(r.sid, role === "project" ? { project: e.target.value } : { task: e.target.value }),
          }) : h("span", { className: "dshh-muted" }, "不需填写")),
          h("td", null, h("div", { className: "dshh-pick" }, action)));
      };
      sections.push(card("会话角色",
        h("div", null,
          h("div", { className: "dshh-muted" }, "选定角色后点「设置角色」，当场生效；按钮随即变为「通知该会话」，再点一次即向它发送整理指令并唤醒一轮。"),
          byActivity.length
            ? h(Folded, {
              rows: byActivity,
              pageSize: 5,
              cols: ["会话", "短号", "水位", "角色", "项目或任务名", "操作"],
              widths: ["30%", "9%", "7%", "12%", "20%", "22%"],
              render: roleRow,
            })
            : h("div", { className: "dshh-muted" }, "暂无可设置角色的会话。空白会话不在此列出。"),
          roleMsg ? h("div", { className: roleBad ? "dshh-bad" : "dshh-ok" }, roleMsg) : null)));

      // 五、全局前置提示词：默认折叠，只显示已保存字数。
      sections.push(card("全局前置提示词",
        h("div", null,
          h("div", { className: "dshh-muted" }, "只注入你填写的内容，不含插件约束；对全部会话生效，位置在工具说明之前。留空保存即不注册提示段。"),
          h("details", null,
            h("summary", { className: "dshh-sum" }, "已保存 " + (extra ? extra.length : 0) + " 字符，点击编辑"),
            h("textarea", {
              className: "dshh-textarea",
              rows: 6,
              value: extra,
              placeholder: "例如：一律用中文；改动前说明改动范围；简单任务不必拆分。",
              onChange: (e) => setExtra(e.target.value),
            }),
            h("div", { className: "dshh-row" },
              h("button", { className: "dshh-btn", type: "button", disabled: working, onClick: saveExtra }, working ? "正在保存" : "保存"),
              h("span", { className: "dshh-muted" }, extra.length + " 字符")),
            extraMsg ? h("div", { className: extraBad ? "dshh-bad" : "dshh-ok" }, extraMsg) : null))));

      // 六、会话水位：只读数据区从这里开始。
      if (ss) {
        const byRecent = (ss.rows || []).slice().sort((a, b) => String(b.seen || "").localeCompare(String(a.seen || "")));
        const waterRow = (r, i) => h("tr", { key: i },
          h("td", null, r.project),
          h("td", { className: "dshh-code dshh-num" }, shortSid(r.sid)),
          h("td", { className: "dshh-num" }, r.pct === null || r.pct === undefined ? "?" : r.pct.toFixed(1) + "%"),
          h("td", null, r.state),
          h("td", null, r.active ? "活跃" : "沉默"),
          h("td", { className: "dshh-muted dshh-num" }, shortTime(r.seen)));
        sections.push(card("会话水位",
          h("div", null,
            h("div", { className: "dshh-muted" }, ss.verdict + "。活跃线 " + ss.cutoff + "，回溯 " + ss.silentHours + " 小时。"),
            (ss.notify || []).length
              ? h("div", null, "本轮需通知：" + ss.notify.map((r) => r.project + "（" + shortSid(r.sid) + "）").join("、"))
              : h("div", { className: "dshh-muted" }, "本轮无需通知。"),
            byRecent.length
              ? h(Folded, {
                rows: byRecent,
                pageSize: 5,
                cols: ["项目", "会话", "水位", "状态", "活跃", "最后活动"],
                widths: ["22%", "13%", "9%", "9%", "9%", "38%"],
                render: waterRow,
              })
              : h("div", { className: "dshh-muted" }, "暂无可显示的项目会话。"))));
      }

      // 七、通用约束条闸门
      if (gate) {
        const rows = (gate.libraries || []).map((r, i) => h("tr", { key: i },
          h("td", null, r.name),
          h("td", null, r.titleOk ? "通过" : "缺"),
          h("td", null, (r.lines - r.missing) + "/" + r.lines),
          h("td", null, r.waterOk ? "通过" : "缺"),
          h("td", null, verdict(r.ok ? "通过" : "未通过", r.ok))));
        sections.push(card("通用约束条闸门",
          gate.error
            ? h("div", { className: "dshh-bad" }, gate.error)
            : h("div", null,
              h("div", { className: "dshh-muted" }, gate.total + " 个库，正文 " + gate.bodyLines + " 行；" + gate.verdict),
              h("table", { className: "dshh-table" },
                h("thead", null, h("tr", null,
                  h("th", null, "库"), h("th", null, "标题"), h("th", null, "正文"), h("th", null, "水位自查"), h("th", null, "结论"))),
                h("tbody", null, rows)))));
      }

      // 八、交接文档体检：问题列只留问题本身，去掉括注与时间要求。
      if (ho) {
        const cleanReason = (x) => String(x || "").replace(/（[^）]*）/g, "").replace(/\s+/g, " ").trim();
        const prows = (ho.projects || []).map((r, i) => h("tr", { key: i },
          h("td", null, r.name),
          h("td", null, r.verdict === "通过" ? verdict("通过", true) : r.verdict === "缺节" ? h("span", { className: "dshh-warn" }, "缺节") : verdict(r.verdict, false)),
          h("td", null, (r.reasons || []).map(cleanReason).filter(Boolean).join("；"))));
        sections.push(card("交接文档体检",
          h("div", null,
            h("div", null, "全局 Global_Handover.md：", ho.global.verdict === "通过" ? verdict("通过", true) : verdict(ho.global.verdict, false),
              (ho.global.reasons || []).length ? h("span", { className: "dshh-muted" }, (ho.global.reasons || []).map(cleanReason).filter(Boolean).join("；")) : null),
            h("table", { className: "dshh-table" },
              h("thead", null, h("tr", null, h("th", null, "项目"), h("th", null, "结论"), h("th", null, "问题"))),
              h("tbody", null, prows)))));
      }

      // 九、插件信息
      sections.push(card("插件", kv([
        ["名称", h("span", { className: "dshh-code" }, p.name + "@" + p.version)],
        ["工具数", String(p.tools)],
        ["压缩调度器", p.scheduler],
        ["注入项", (p.inject || []).join("、")],
        ["初始化", (p.initErrors && p.initErrors.length) ? h("span", { className: "dshh-bad" }, p.initErrors.join("；")) : verdict("无错误", true)],
        ["工作区", ws.found ? h("span", { className: "dshh-code" }, ws.root) : verdict("未接入（未找到 _Control_Center）", false)],
      ])));

      // 十、会话间通信守卫
      const g = data.guardLast;
      sections.push(card("会话间通信守卫",
        g
          ? kv([
            ["结论", g.allow ? verdict("允许", true) : verdict("拒绝", false)],
            ["依据", g.source + (g.title ? "；会话标题 " + g.title : "")],
            ["会话", h("span", { className: "dshh-code" }, g.sid || "-")],
          ])
          : h("div", { className: "dshh-muted" }, "本进程尚未收到会话间通信请求，暂无判定。")));

      if ((data.notes || []).length) {
        sections.push(card("待处理", h("ul", { className: "dshh-list" }, data.notes.map((n, i) => h("li", { key: i }, n)))));
      }

      // 末、使用说明：参考性质，放最后，默认折叠。
      const gd = data.guide;
      if (gd) {
        const sit = (gd.situations || []).map((r, i) => h("tr", { key: i },
          h("td", null, r.when),
          h("td", null, r.say),
          h("td", { className: "dshh-muted" }, r.what)));
        const groups = (gd.groups || []).map((gr, i) => h("div", { key: i },
          h("div", { className: "dshh-sub" }, gr.title),
          h("table", { className: "dshh-table" }, h("tbody", null, (gr.tools || []).map((t, j) => h("tr", { key: j },
            h("td", { className: "dshh-code" }, t[0]),
            h("td", { className: "dshh-muted" }, t[1])))))));
        sections.push(card("使用说明",
          h("details", null,
            h("summary", { className: "dshh-sum" }, "交互方式、常见请求、工具清单与约定"),
            h("div", { className: "dshh-wrap" },
              (gd.intro || []).map((t, i) => h("div", { key: i }, t)),
              h("div", { className: "dshh-sub" }, "常见请求与对应动作"),
              h("table", { className: "dshh-table" },
                h("thead", null, h("tr", null, h("th", null, "时机"), h("th", null, "可以这样说"), h("th", null, "插件会执行的动作"))),
                h("tbody", null, sit)),
              groups,
              h("div", { className: "dshh-sub" }, "约定"),
              h("ul", { className: "dshh-list" }, (gd.rules || []).map((t, i) => h("li", { key: i }, t)))))));
      }

      return h("div", { className: "dshh-root" }, head, sections);
    }

    /** 把只读状态页注册进设置导航。 */
    function apply(ctx) {
      try { connection = (ctx && ctx.connection) || null; } catch (e) { connection = null; }
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "handover",
        order: 100,
        label: "dsh-handover",
      }, HandoverSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});