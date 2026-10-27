# 消息投递：Queue 与 Steering

WorkBuddy 里往一个会话投递消息，有两种处理方式。产品界面把它们放在发送按钮旁边切换，
但底层只有一个字段。这篇记录它是怎么工作的，免得下次再从压缩代码里翻一遍。

| 模式 | 行为 | 现象 |
| --- | --- | --- |
| Queue（默认） | 消息进队列，等当前轮次结束才被处理 | 输入框上方出现一条待发送引用条 |
| Steering | 忙的时候立即插进当前轮次 | 消息直接落进对话流，当前轮能读到 |

## 底层字段

渲染层在 `runSendPrompt` 里做决策：

```js
T = !_startIntent && this.wouldQueue();               // 当前是否忙
D = T && transport !== "cloud"
      && getQueueSendMode() === "immediate"
      && !forceQueue ? "steer" : undefined;

options = {
  ...(T ? { emitUserMessage: true, _expectQueueReceipt: true } : {}),
  ...(D ? { queueDelivery: D } : {}),
};
```

消费点在 core 的 `sendPrompt`：

```js
let { queueDelivery: u, ...rest } = options;

if (!busy && !priority) {
  queueImpl.drainNext();                     // 空闲：直接发
} else if (u === "steer" && busy && !pauseReason) {
  queueImpl.sendNow(queueItemId, { origin: "auto" });   // 忙：立即插入
}
```

所以**决定权在 `queueDelivery`**，值就是字符串 `"steer"`。`getQueueSendMode() === "immediate"`
只是界面开关，最终也折算成这个字段。

## 对会话桥的影响

`promptWb` 原来只传 `emitUserMessage: true`，于是走默认排队分支——对方说的话挂在输入框上方，
要等当前轮跑完才进来。会话桥的语义是「对方一说话，我这边马上看到」，所以现在默认传
`queueDelivery: "steer"`：

```js
const delivery = payload?.delivery || "steer";
const options = { emitUserMessage: true };
if (delivery === "steer") options.queueDelivery = "steer";
```

需要退回排队行为时传 `delivery: "queue"`。

## 实测（12:00，真实宿主）

A = `a1b2c3d4-0003-4a00-8000-000000000003`（发起方，**当时正在跑一轮**）
B = `a1b2c3d4-0013-4a00-8000-000000000013`

| 时刻 | 事件 |
| --- | --- |
| 12:00:32 | A 指示 B 执行 steer 投递 |
| 12:00:44 | A 的本地记录出现一条 `role: user` 消息，内容即 B 所发 |
| 12:02:10 | **A 这一轮的最后一个工具调用才结束** |
| 12:02:17 | A 开始下一轮推理，读到该消息 |

关键在第三行：消息 12:00:44 就进了对话流，而 A 的当前轮直到 12:02:10 才收工。
如果走 Queue，它应该等到 12:02:10 之后才 drain。所以这次是真正的 steering。

对照组是同一对会话在改代码之前的表现：11:53 投递的消息挂在输入框上方，
直到 11:57（上一轮结束之后）才作为用户消息落库——那是 Queue。

## 一个还没补的细节

Steering 消息在渲染层会带 `_meta["codebuddy.ai"]["queueOrigin"] = "steer"`，
本地记录扫描器靠它识别插队来源。但从 service 直接调 `sendPrompt` 时没有这层包装，
所以实测那条记录里 `_meta` 只有 traceparent/baggage，没有 `queueOrigin`。

对功能没有影响，只影响「事后从 `.jsonl` 里分辨哪些消息是 steer 进来的」。
要补的话得给 `promptWb` 加 `_meta`，注意宿主会读这个字段解析 requestId，需单独验证后再动。

## 生效条件

扩展 service 是**宿主启动时 fork** 的，改完 `server/index.cjs` 必须重新安装扩展并重启客户端：

```bash
node bin/dsh2wb.mjs install-extension
```

单独 kill service 进程不会让宿主自动重建，`wb-call` 会一直等到超时。
