# data/books 存储说明

- `index.json`：书架索引，只包含 `schemaVersion: 2` 的书。
- `<bookId>/`：书籍数据目录（`book.json`、`shared/`、`chapters/<chapterId>/`）。
- 书籍由应用导入流程写入，请勿手工修改目录结构。
