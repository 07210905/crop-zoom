# dsh-crop-zoom

**把图上的小字裁出来放大，让模型真的能认。**

[DeepSeek Harness](https://github.com/deepseek-ai)（`dsh`）插件，注册一个 `crop_zoom` 工具；
同一套引擎也提供独立命令行。
[English →](README.md)

- 纯本地图像处理 —— 不联网、不调用模型、不含 OCR 引擎。
- 只有一个依赖 `sharp`（libvips），并且**延迟加载**：原生模块坏了也只会让一次工具调用失败，不会让整个 harness 起不来。
- Node ≥ 22，MIT。

---

## 它解决什么问题

一张 1920×1080 的截图**不是**以 1920×1080 送到模型面前的。中途会被降采样，于是 10–11px
的道具名笔画已经粘在一起 —— 再看一遍原图也没用，那些像素已经没了。

同一个结算界面上的四处读数，全都以同样的方式读错：

| 实际印的 | 读出来的 | 为什么 |
| --- | --- | --- |
| `03重型盔` | `D3重型盔` | 11px 时 `0` 和 `D` 共用一条左竖 |
| `BT6重型` | `B16重型` | `T` 和前一个 `B` 粘成一个字 |
| `1000戰地包` | `100D戰地包` | 四位数字并成三位加一个字母 |
| `鎏影權鋒` | `盜影權杖` | `鎏` 下面的「金」塌成了「皿」的样子 |

把这些区域**先裁出来放大再看**，字就清清楚楚。顺序不能颠倒，而且比把整张截图再送一遍便宜得多。

## 作为 dsh 插件安装

```bash
dsh plugin --profile <profile> add dsh-crop-zoom     # 从 registry 装
dsh plugin --profile <profile> add ./dsh-crop-zoom   # 从本地目录装
```

然后重启应用。模型就多了一个 `crop_zoom` 工具，而且它的 schema 会随**每一次请求**重新送到模型面前。

## 作为命令行安装

```bash
npm install -g dsh-crop-zoom
crop-zoom -i shot.png -r 1178,588,64,24 -s 16 -o label.png
```

## 工具怎么用

```jsonc
// 单个区域，自动放大到长边 1600px
{ "path": "C:\\shots\\raid.png", "regions": [{ "x": 1178, "y": 588, "width": 64, "height": 24 }] }

// 两个区域拼成一张带标注的图，后续只需读一次
{ "path": "C:\\shots\\raid.png",
  "regions": [{ "x": 80,  "y": 430, "width": 540, "height": 300, "label": "rank board" },
              { "x": 875, "y": 155, "width": 450, "height": 660, "label": "gear" }],
  "target": 2400 }

// 还是看不清？nearest 保留像素块，专门用来分辨等宽字形
{ "path": "C:\\shots\\raid.png", "regions": [{ "x": 1444, "y": 373, "width": 96, "height": 42 }],
  "scale": 16, "mode": "nearest" }
```

工具写出 PNG 并返回路径，接着用 `read_image` 读它。返回的文本**只有几何信息**，故意如此 ——
免得被当成答案：

```
1 file written from C:\shots\raid.png (1920x1080), kernel bicubic.

#1  source 1178,588 64x24  x12  -> 768x288
#2  source 1444,373 96x42  x12  -> 1152x504

Sheet (regions stacked top to bottom, in the order above): C:\...\raid-20261014181815.png

Now read that file with read_image. Do not answer from this geometry summary alone.
```

### 参数

| 名称 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `path` | string | — | 源图绝对路径。必填。 |
| `regions` | array | — | 1–8 个区域，按拼图顺序。必填。每项 `{x, y, width, height, label?}`，坐标是**源图像素**。 |
| `scale` | integer | — | 整数放大倍数，1–16。不填则由 `target` 推导。 |
| `target` | integer | `1600` | 无 `scale` 时，把区域长边放大到这么多像素，上限 16×。 |
| `mode` | enum | `bicubic` | `bicubic` \| `nearest` \| `lanczos` \| `mitchell`。 |
| `sheet` | boolean | `true` | 把所有区域拼成一张带标注的 PNG；`false` 则每个区域各写一个文件。 |
| `outPath` | string | 临时目录 | 输出位置，必须以 `.png` 结尾。 |
| `previewWidth` | integer | — | 坐标是在降采样预览图上量的时填它：填预览图的像素宽度，所有坐标自动换算到原图。 |

`bicubic` 保留字形轮廓，是合适的默认值。`nearest` 复制整块像素，能把 `0` 和 `D` 分开 ——
两者互补，某个字还是定不下来时，两种都看一眼。

### 命令行

```
crop-zoom -i <image> -r <x,y,w,h> [-r <x,y,w,h> ...] [options]

  -i, --image <path>        源图（PNG / JPEG / WebP / AVIF / TIFF / GIF）
  -r, --region <x,y,w,h>    要放大的区域，最多重复 8 次
  -s, --scale <n>           整数放大倍数，1..16
  -t, --target <px>         自动放大目标（默认 1600）
  -m, --mode <kernel>       bicubic（默认）| nearest | lanczos | mitchell
  -o, --out <file.png>      输出路径；每区域一个文件时作为文件名前缀
      --preview-width <px>  坐标来自这个宽度的预览图
      --no-sheet            每区域一个文件，不拼图
      --json                额外打印原始结果对象
  -h, --help                显示帮助
```

## 实现

1. 源图一次性解码进内存。区域边界按**显示尺寸**（EXIF 旋转之后）校验，所以竖拍照片按你看到的方向裁。
2. 逐区域 `extract`，再按**整数倍**用选定核 `resize` —— 整数放大不会在你正要读的笔画上引入重采样痕迹。
3. 需要时把各块合成一张图，每块上方标注几何信息，这样多区域核对只要再读一次。

## 限制

- **只处理本地文件。** 不会去抓远程 URL，避免这个工具变成替模型发外部请求的通道。
- 输出固定为 PNG。
- 每次最多 8 个区域、16× 放大。
- 拼图上的标注是 ASCII；非拉丁标注能不能画出来取决于 fontconfig 给 librsvg 暴露了哪些字体，
  所以中文描述请写在区域 `label` 里，别指望它出现在图上。

## 开发

```bash
npm install
npm test        # 核心几何测试 + 插件契约测试
```

`test/run.mjs` 自己合成测试图，断言精确的输出尺寸。
`test/plugin.mjs` 用桩 `ctx` 跑 `apply()`，并验证注册表抛错也不会逸出。

## 许可

MIT
