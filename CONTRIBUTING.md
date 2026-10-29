# 贡献指南

欢迎为 Aurora Music 提交 Issue 和 Pull Request。

## 报告问题 / 提建议

用仓库自带的 Issue 模板（Bug 反馈 / 功能建议）。报告 Bug 时请附上 Aurora 版本、Windows 版本和复现步骤；设置 → 诊断可以导出日志，粘贴关键片段即可——**请勿附上任何密钥、令牌或个人路径信息**。

## 开发环境

```bash
npm install
npm run dev          # 开发模式
npm run verify       # 提交前必须全绿：类型检查 + Lint + 全部冒烟测试 + 构建
```

架构与落盘位置见 [开发文档](docs/DEVELOPMENT.md)，音源机制见 [音源运行时设计](docs/SOURCE-RUNTIME-DESIGN.md)。

## 提交约定

- 一个 PR 只做一件事；改动说明里写清「改了什么、为什么、怎么验证的」
- 提交信息用英文前缀风格，如 `feat:` / `fix:` / `docs:` / `chore:`
- 涉及界面改动时附截图

## 两条硬约束

1. **不复制其他项目的代码。** 可以对齐能力与行为（参见 [洛雪对齐路线图](docs/LX-PARITY-ROADMAP.md)），但实现、UI、文案全部自己写，不搬运源码与品牌资源。
2. **不放松安全边界。** 脚本音源的沙箱隔离、按主机授权、密钥加密存储、IPC 发送方校验是设计地基；任何改动若削弱其中一条，必须在 PR 里明确说明并给出替代防护。
