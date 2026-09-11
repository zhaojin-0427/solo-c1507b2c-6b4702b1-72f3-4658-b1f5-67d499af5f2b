# 套色木刻工作台

本机 Web 工作台,用于套色木刻的**分版、试印校准与版序比较**。

- 后端:Python Flask + SQLite(数据存于 `woodcut.db`)
- 前端:原生 HTML / CSS / JavaScript + Canvas,无任何构建步骤

## 运行

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
# 打开 http://127.0.0.1:5000
```

## 功能流程

1. **项目与色版**:建立 2～8 块色版,导入底稿;每版可设油墨颜色、透明度、区域目标色、最小可刻线宽、3 个套准标记、纸张方向与干燥规则。
2. **区域勾勒**:在画布上逐点单击勾勒各版封闭区域,可设区域级目标色。
3. **合成预览与检测**:按版序合成预览,一键检测露白、非预期叠色、过窄线条、越出纸面。
4. **套准模拟**:拖动(Alt+拖动旋转)模拟各版横纵偏移与旋转,实时列出各目标区域的最大错位。
5. **试印校准**:录入 3 个标记的设计/实测坐标,最小二乘解算平移+旋转+统一缩放修正,可叠加修正前后轮廓,并把修正应用回色版;记录入库。
6. **版序优化**:锁定部分版的印次或修正,枚举剩余版序,按目标混色误差 → 清墨换色次数 → 干燥等待次数排序;选定方案入库并回写版序。
7. **输出**:逐版水平镜像转印图(PNG)与可打印的套准校准页。

## API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/projects` | 项目列表 / 新建 |
| GET/PUT/DELETE | `/api/projects/<id>` | 项目读写删 |
| POST | `/api/projects/<id>/blocks` | 添加色版(≤8) |
| PUT/DELETE | `/api/blocks/<id>` | 修改 / 删除色版(≥2) |
| POST | `/api/blocks/<id>/regions` | 添加封闭区域 |
| PUT/DELETE | `/api/regions/<id>` | 修改 / 删除区域 |
| POST | `/api/blocks/<id>/trials` | 试印三点解算并记录 |
| GET | `/api/projects/<id>/trials` | 试印记录 |
| POST | `/api/projects/<id>/enumerate` | 枚举版序并排序 |
| GET/POST | `/api/projects/<id>/plans` | 方案列表 / 保存 |
