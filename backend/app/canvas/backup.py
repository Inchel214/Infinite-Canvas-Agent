"""画布数据镜像备份：后端服务自带的后台定时任务。

服务启动时先做一次备份，之后按固定间隔（默认每小时）自动执行，
无需任何外部脚本或系统定时任务。只保留一份备份，每次镜像覆盖：
  - 源目录新增/修改的文件 -> 复制到目标
  - 源目录已删除的文件    -> 目标同步删除（与源完全一致）
  - 未变化的文件          -> 跳过（增量复制，开销极小）

目标路径用 CANVAS_BACKUP_DIR 配置（默认 backend/data/backup/，跟随
CANVAS_DATA_DIR），设为空字符串可禁用备份；间隔用 CANVAS_BACKUP_INTERVAL（秒）配置。

防护目标：Agent 误删画布、手滑删除等误操作——Agent 工具只操作
canvases/chats/images 等业务路径，不会触碰 backup/ 目录。
注意备份与源同盘，防不了磁盘物理损坏。
"""
import asyncio
import logging
import os
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

# 排除目录：logs 是运行日志无备份价值；backup 是备份目录自身，
# 默认目标在源目录内部，不排除会递归备份（backup/backup/...）
_EXCLUDE_DIRS = {"logs", "__pycache__", "backup"}


def default_data_dir() -> Path:
    """与 store.py 相同的源目录解析：CANVAS_DATA_DIR，默认 backend/data"""
    env_dir = os.getenv("CANVAS_DATA_DIR")
    if env_dir:
        return Path(env_dir)
    return Path(__file__).resolve().parent.parent.parent / "data"


def default_backup_dir() -> Path:
    """默认备份目标：数据目录下的 backup/ 子目录（项目内部，Agent 不触碰）"""
    return default_data_dir() / "backup"


def _iter_files(root: Path):
    """遍历源目录所有文件（相对路径），跳过排除目录"""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _EXCLUDE_DIRS]
        for name in filenames:
            full = Path(dirpath) / name
            yield full.relative_to(root)


def mirror_backup(source: Path, dest: Path) -> dict:
    """把 source 镜像到 dest（单份覆盖式备份），返回统计信息。

    变化判断用 size + mtime（与 robocopy 默认策略一致），
    避免全量哈希大文件带来的 IO 开销。
    """
    source = Path(source)
    dest = Path(dest)
    if not source.is_dir():
        raise FileNotFoundError(f"备份源目录不存在: {source}")
    dest.mkdir(parents=True, exist_ok=True)

    stats = {"copied": 0, "deleted": 0, "skipped": 0}
    source_files = set()

    for rel in _iter_files(source):
        source_files.add(rel)
        src_file = source / rel
        dst_file = dest / rel
        try:
            src_stat = src_file.stat()
            if dst_file.exists():
                dst_stat = dst_file.stat()
                if (
                    dst_stat.st_size == src_stat.st_size
                    and int(dst_stat.st_mtime) == int(src_stat.st_mtime)
                ):
                    stats["skipped"] += 1
                    continue
            dst_file.parent.mkdir(parents=True, exist_ok=True)
            # copy2 保留 mtime，下次备份可正确识别"未变化"
            shutil.copy2(src_file, dst_file)
            stats["copied"] += 1
        except OSError as e:
            # 单个文件失败（如正被写入）不中断整轮备份，下轮自动补
            logger.warning("备份跳过文件 %s: %s", rel, e)

    # 镜像语义：目标里源已不存在的文件要删掉
    for rel in list(_iter_files(dest)):
        if rel not in source_files:
            try:
                (dest / rel).unlink()
                stats["deleted"] += 1
            except OSError as e:
                logger.warning("备份清理失败 %s: %s", rel, e)

    # 清理目标里的空目录（源已删除的目录不保留空壳）
    for dirpath, dirnames, filenames in os.walk(dest, topdown=False):
        p = Path(dirpath)
        if p != dest and not dirnames and not filenames:
            try:
                p.rmdir()
            except OSError:
                pass

    return stats


async def backup_loop(source: Path, dest: Path, interval: float) -> None:
    """后台备份循环：启动立即备一次，之后每 interval 秒一次。

    备份是同步 IO，扔到线程池执行，不阻塞事件循环。
    任何异常只记日志，绝不让备份任务把服务搞挂。
    """
    while True:
        try:
            stats = await asyncio.to_thread(mirror_backup, source, dest)
            logger.info(
                "数据备份完成 -> %s（复制 %d，清理 %d，未变化 %d）",
                dest, stats["copied"], stats["deleted"], stats["skipped"],
            )
        except Exception:
            logger.exception("数据备份失败（%s 秒后重试）", interval)
        await asyncio.sleep(interval)


def start_backup_task() -> "asyncio.Task | None":
    """按环境变量配置启动后台备份任务；未配置目标目录时返回 None（禁用）。"""
    dest = os.getenv("CANVAS_BACKUP_DIR", str(default_backup_dir())).strip()
    if not dest:
        logger.info("数据备份未启用（CANVAS_BACKUP_DIR 为空）")
        return None
    interval = float(os.getenv("CANVAS_BACKUP_INTERVAL", "3600"))
    task = asyncio.create_task(backup_loop(default_data_dir(), Path(dest), interval))
    logger.info("数据备份已启动：每 %.0f 秒镜像到 %s", interval, dest)
    return task
