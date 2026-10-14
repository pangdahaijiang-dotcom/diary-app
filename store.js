// store.js —— 日记的本地存储（增 / 删 / 改 / 查）
// 说明：纯前端，数据只存在你自己的浏览器里，不上传到任何服务器。
// 开源时这些数据不会进仓库（只存在你本地浏览器），所以隐私安全。
const Store = {
  // 读取全部日记，按时间从新到旧排序
  getAll() {
    try {
      const raw = localStorage.getItem(CONFIG.diaryStorageKey);
      const list = raw ? JSON.parse(raw) : [];
      return list.sort((a, b) => b.createdAt - a.createdAt);
    } catch (e) {
      console.error("读取日记失败：", e);
      return [];
    }
  },

  // 保存一篇新日记（自动补 id 和时间戳）
  save(diary) {
    const list = this.getAll().sort((a, b) => a.createdAt - b.createdAt); // 先恢复正序再追加
    // id 用时间戳生成，但必须保证唯一：同一毫秒内连存两篇会撞 id，
    // 而 id 是 update / remove 定位记录的唯一依据 —— 撞了就会改错篇、删错篇。
    // （这个坑是写编辑功能的测试时撞出来的：连着 Store.save 两次就复现了。）
    const base = "d_" + Date.now();
    let id = base;
    let n = 1;
    while (list.some((d) => d.id === id)) id = base + "_" + (++n);
    const record = Object.assign(
      { id, createdAt: Date.now() },
      diary
    );
    list.push(record);
    localStorage.setItem(CONFIG.diaryStorageKey, JSON.stringify(list));
    return record;
  },

  // 按 id 更新一篇日记（只覆盖 patch 里带的字段，其余保持原样）
  // 两个刻意为之的保护：
  //   · id / createdAt 强制用原值 —— 用户改的是内容，不该把"什么时候写的"改掉；
  //   · 找不到 id 返回 null（而不是假装成功），调用方才能给出真实提示。
  //   · editedAt 记下"最后一次手改时间"，界面不显示，但数据必须是诚实的。
  update(id, patch) {
    const list = this.getAll();
    const i = list.findIndex((d) => d.id === id);
    if (i < 0) return null;
    const merged = Object.assign({}, list[i], patch, {
      id: list[i].id,
      createdAt: list[i].createdAt,
      editedAt: Date.now(),
    });
    list[i] = merged;
    localStorage.setItem(CONFIG.diaryStorageKey, JSON.stringify(list));
    return merged;
  },

  // 按 id 删除一篇日记
  remove(id) {
    const list = this.getAll().filter((d) => d.id !== id);
    localStorage.setItem(CONFIG.diaryStorageKey, JSON.stringify(list));
  },
};
