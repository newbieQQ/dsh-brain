# Source provenance / 源码来源

- 上游项目：`newbieQQ/dsh-cloud-memory`（GitHub）
- 本工作树基线：npm 包 `dsh-cloud-memory@0.4.1`，上游 main 提交 `1865a82a274c1b2aecd8ebf8abbe787124a409e2`
- 取得方式：GitHub 已认证 API 归档解包，**不是** `git clone`；因此本仓库没有上游提交历史。
- 基线提交：`vendor: dsh-cloud-memory 0.4.1 baseline (upstream 1865a82)` —— 该提交内容逐字节等于上述归档内容（仅追加本文件与 .gitignore 条目）。
- 追加的构建支持：`../node_modules` 是指向本地开发依赖（typescript / @types / @deepseek-ai 类型）的 junction，仅用于 `tsc`，不进版本库，也不是运行时依赖。
- 后续每一处本地差异都以独立提交记录，`git log --oneline vendor..main` 即本地改动清单。
