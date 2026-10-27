# 文档地图

README 负责「要不要用」，这里负责「怎么改、为什么这么设计、坏了怎么查」。

## 按你想做的事找

| 我想… | 读这篇 |
| --- | --- |
| 装上、跑起来 | [../README.md](../README.md) 的「装」，或包里的 `使用说明.txt` |
| 出了问题 | **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** —— 症状 → 原因 → 处理 |
| 改代码 / 看懂分层 | **[ARCHITECTURE.md](ARCHITECTURE.md)** —— 四层、两种运行方式、每个文件干什么 |
| 知道这些结论怎么来的 | **[REVERSE-ENGINEERING.md](REVERSE-ENGINEERING.md)** —— 没有菜单插槽，于是找到调试端口 |
| 查通道名、菜单 DOM、剪贴板接口 | **[PROTOCOL.md](PROTOCOL.md)** —— 实测事实清单 |
| 看每个版本改了什么 | [../CHANGELOG.md](../CHANGELOG.md) |
| 参与开发 / 打包发版 | [../CONTRIBUTING.md](../CONTRIBUTING.md) |

## 分工

```
README.md                30 秒讲清价值 + 安装三步
  └─ docs/
       TROUBLESHOOTING.md     按症状索引，面向使用者
       ARCHITECTURE.md        分层与职责，面向改代码的人
       REVERSE-ENGINEERING.md 为什么是这条路，面向好奇的人
       PROTOCOL.md            事实清单（通道、DOM、IPC），面向要对接的人
```

**PROTOCOL 是「事实」，ARCHITECTURE 是「设计」，REVERSE-ENGINEERING 是「过程」。**
三者会有重叠，但视角不同：查名字去 PROTOCOL，改结构去 ARCHITECTURE，
想知道「为什么不用另一种做法」去 REVERSE-ENGINEERING。

## 维护约定

- 文档里的通道名、选择器、字段，必须能在代码里指出对应行；改了代码顺手改文档。
- 版本号四处一致：`package.json`、`extension/extension.json`、`extension/distribution.json`、
  `extension/server/index.cjs` 的 `VERSION`，外加 `CHANGELOG.md` 最新一节。
  `test/setup.test.mjs` 会卡这几处。
- 没有截图。这个项目的界面就是宿主自己的菜单，截图意义不大；
  ASCII 示意图 + 真机验证记录比截图可靠。
