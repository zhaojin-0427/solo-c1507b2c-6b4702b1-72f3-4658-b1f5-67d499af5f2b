# -*- coding: utf-8 -*-
"""多张试印稳定性分析端到端冒烟测试(使用临时 SQLite)。"""
import json, os, tempfile, math

tmp = tempfile.mkdtemp()
os.environ["TMP"] = tmp
import app as A
A.DB_PATH = os.path.join(tmp, "smoke.db")
A.init_db()
c = A.app.test_client()


def jpost(path, body):
    r = c.post(path, data=json.dumps(body), content_type="application/json")
    assert r.status_code in (200, 201), (path, r.status_code, r.get_json())
    return r.get_json()


def jget(path, code=200):
    r = c.get(path)
    assert r.status_code == code, (path, r.status_code, r.get_json())
    return r.get_json()


def jput(path, body):
    r = c.put(path, data=json.dumps(body), content_type="application/json")
    assert r.status_code in (200, 201), (path, r.status_code, r.get_json())
    return r.get_json()


# 项目 + 3 色版,每版 3 标记
p = jpost("/api/projects", {"name": "冒烟", "paper_w": 200, "paper_h": 280})
pid = p["id"]
b1 = jpost(f"/api/projects/{pid}/blocks", {"name": "黑版", "ink_color": "#000000"})["blocks"][-1]
b2 = jpost(f"/api/projects/{pid}/blocks", {"name": "红版", "ink_color": "#a33b20"})["blocks"][-1]
b3 = jpost(f"/api/projects/{pid}/blocks", {"name": "蓝版", "ink_color": "#1565c0"})["blocks"][-1]
M = [[20, 20], [180, 20], [100, 260]]
for b in (b1, b2, b3):
    jput(f"/api/blocks/{b['id']}", {"reg_marks": [{"x": x, "y": y} for x, y in M]})

# 建批次
bch = jpost(f"/api/projects/{pid}/trial-batches", {"name": "批次A"})
bid = bch["id"]
assert len(bch["snapshot"]["blocks"]) == 3
assert bch["status"] == "collecting"

# 5 张:平移随印刷顺序漂移,第 3 张突变,第 4 张一个离群点,第 5 张漏一个点
def sim(sid, seq, drift, jump=0.0, outlier=False, miss_b1=False, feed="normal"):
    extra = 1.2 if jump else 0.0
    for b in (b1, b2, b3):
        for mi, (x, y) in enumerate(M):
            if miss_b1 and b["id"] == b1["id"] and mi == 2:
                continue
            dx = drift + extra + (0.3 if b is b2 else 0.0) + (0.6 if b is b3 else 0.0)
            dy = 0.0
            ox = 2.0 if (outlier and b["id"] == b2["id"] and mi == 1) else 0.0
            jpost(f"/api/trial-sheets/{sid}/measures",
                  {"block_id": b["id"], "mark_index": mi,
                   "mx": round(x + dx + ox, 3), "my": round(y + dy, 3)})
    jput(f"/api/trial-sheets/{sid}", {"printed_at": f"2026-09-14 10:0{seq}", "feed": feed})


for k in range(5):
    sh = jpost(f"/api/trial-batches/{bid}/sheets", {"name": f"张{k+1}"})
    sid = sh["sheets"][-1]["id"]
    sim(sid, k, drift=0.15 * k, jump=(k == 2),
        outlier=(k == 3), miss_b1=(k == 4),
        feed="turn180" if k == 3 else "normal")

full = jget(f"/api/trial-batches/{bid}")
res = full["results"]
fit = [s for s in res["sheets"] if s["fittable"]]
print("fittable:", len(fit), "/ 5")
assert len(fit) == 5
# 漂移:黑版平移 x 应单调上升
t0 = fit[0]["tx_by_block"][str(b1["id"])]
t4 = fit[4]["tx_by_block"][str(b1["id"])]
assert t4[0] > t0[0] + 0.4, (t0, t4)
# 版间差:红版相对黑版约 0.3,蓝版约 0.6
m0 = {m["block_id"]: m["mag"] for m in fit[0]["misreg"]}
assert abs(m0[b2["id"]] - 0.3) < 0.15 and abs(m0[b3["id"]] - 0.6) < 0.15, m0
# 残差应较小(无离群的张)
assert fit[0]["max_res"] < 0.05, fit[0]["max_res"]
# 问题类型齐全
types = {i["type"] for i in res["issues"]}
print("issue types:", sorted(types))
for need in ("drift", "jump", "outlier", "missing", "misreg", "feed_change"):
    assert need in types, need
# 建议修正:排除突变张与离群张后,红版中位应收敛到 0.45、蓝版 0.75
sids0 = {s["seq"]: s["id"] for s in full["sheets"]}
jput(f"/api/trial-sheets/{sids0[2]}",
     {"excluded": True, "exclude_reason": "突变废张:进纸打滑"})
jput(f"/api/trial-sheets/{sids0[3]}",
     {"excluded": True, "exclude_reason": "该张测量时纸张未靠紧定位槽"})
full3 = jget(f"/api/trial-batches/{bid}")
sug2 = full3["results"]["suggestions"]
assert abs(sug2[str(b2["id"])]["tx"] - 0.45) < 0.20, sug2
assert abs(sug2[str(b3["id"])]["tx"] - 0.75) < 0.20, sug2
assert sug2[str(b1["id"])]["n"] == 3
# 恢复两张(后续冻结/应用流程需要全部 5 张可见)
jput(f"/api/trial-sheets/{sids0[2]}", {"excluded": False})
jput(f"/api/trial-sheets/{sids0[3]}", {"excluded": False})

# 锁定第 1 张为可信;演示单点排除:排除第 4 张离群测点后该张残差恢复
sids = sids0
jput(f"/api/trial-sheets/{sids[0]}", {"trusted": True})
m4 = [m for m in full3["measures"][str(sids[3])]
      if m["block_id"] == b2["id"] and m["mark_index"] == 1][0]
r = jput(f"/api/trial-measures/{m4['id']}", {"excluded": True, "reason": "测错点"})
s3 = next(s for s in r["results"]["sheets"] if s["seq"] == 3)
assert s3["max_res"] < 0.05, s3["max_res"]
# 恢复测点;再用整张拉排除第 4 张
jput(f"/api/trial-measures/{m4['id']}", {"excluded": False})
r = jput(f"/api/trial-sheets/{sids[3]}",
         {"excluded": True, "exclude_reason": "测量时纸张未靠紧定位槽"})
s3 = next(s for s in r["results"]["sheets"] if s["seq"] == 3)
assert s3["excluded_sheet"] and not s3["fittable"]
# 可信印张不允许排除其测点/整张拉
m1 = [m for m in r["measures"][str(sids[0])] if m["block_id"] == b1["id"]][0]
rr = c.put(f"/api/trial-measures/{m1['id']}", data=json.dumps({"excluded": True}),
           content_type="application/json")
assert rr.status_code == 409, rr.status_code
rr = c.put(f"/api/trial-sheets/{sids[0]}", data=json.dumps({"excluded": True, "exclude_reason": "x"}),
           content_type="application/json")
assert rr.status_code == 409, rr.status_code

# 确认冻结:测量写入应被拒
conf = jpost(f"/api/trial-batches/{bid}/confirm", {})
assert conf["status"] == "confirmed"
rr = c.post(f"/api/trial-sheets/{sids[0]}/measures",
            data=json.dumps({"block_id": b1["id"], "mark_index": 0, "mx": 9, "my": 9}),
            content_type="application/json")
assert rr.status_code == 409, rr.status_code
# 张数不足 3 的批次不可确认(建空批次)
bch2 = jpost(f"/api/projects/{pid}/trial-batches", {"name": "空"})
rr = c.post(f"/api/trial-batches/{bch2['id']}/confirm",
            data=json.dumps({}), content_type="application/json")
assert rr.status_code == 400, rr.status_code

# 应用建议修正:只写勾选的未锁定版;既有 trials 表不受影响(本来为空)
before = {b["name"]: (b["offset_x"], b["offset_y"]) for b in
          jget(f"/api/projects/{pid}")["blocks"]}
ap = jpost(f"/api/trial-batches/{bid}/apply-corrections",
           {"block_ids": [b1["id"], b2["id"]]})
after = {x["name"]: (x["offset_x"], x["offset_y"]) for x in ap["project"]["blocks"]}
assert after["黑版"] != before["黑版"]
assert after["蓝版"] == before["蓝版"]
print("applied:", [(a["name"], a["tx"], a["ty"]) for a in ap["applied"]])
# 再次应用蓝版(仍可用,批次结果冻结,建议不变)
ap2 = jpost(f"/api/trial-batches/{bid}/apply-corrections", {"block_ids": [b3["id"]]})
# 未确认批次不能应用
c.post(f"/api/trial-batches/{bch2['id']}/sheets", data=json.dumps({}),
       content_type="application/json")
for k in range(2):
    c.post(f"/api/trial-batches/{bch2['id']}/sheets", data=json.dumps({}),
           content_type="application/json")
rr = c.post(f"/api/trial-batches/{bch2['id']}/apply-corrections",
            data=json.dumps({"block_ids": [b1["id"]]}), content_type="application/json")
assert rr.status_code == 409, rr.status_code

# 重新打开后可补录,重新确认
jpost(f"/api/trial-batches/{bid}/reopen", {})
jpost(f"/api/trial-sheets/{sids[4]}/measures",
      {"block_id": b1["id"], "mark_index": 2,
       "mx": M[2][0] + 0.7, "my": M[2][1]})
jpost(f"/api/trial-batches/{bid}/confirm", {})

# 列表
lst = jget(f"/api/projects/{pid}/trial-batches")
assert len(lst) == 2 and lst[0]["n_sheets"] in (3, 5)
print("list:", lst)
print("SMOKE OK")
