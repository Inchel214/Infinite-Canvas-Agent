"""镜像备份逻辑测试：新增复制 / 变化更新 / 删除同步 / 目录排除"""
import os
import time
from pathlib import Path

import pytest

from app.canvas.backup import mirror_backup


@pytest.fixture
def dirs(tmp_path):
    src = tmp_path / "data"
    dst = tmp_path / "backup"
    src.mkdir()
    return src, dst


def _write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_new_files_are_copied(dirs):
    src, dst = dirs
    _write(src / "canvases" / "c1.json", "{}")
    _write(src / "settings.json", "{}")
    stats = mirror_backup(src, dst)
    assert stats["copied"] == 2
    assert (dst / "canvases" / "c1.json").read_text(encoding="utf-8") == "{}"
    assert (dst / "settings.json").exists()


def test_unchanged_files_are_skipped_on_second_run(dirs):
    src, dst = dirs
    _write(src / "a.json", "v1")
    mirror_backup(src, dst)
    stats = mirror_backup(src, dst)
    assert stats["copied"] == 0
    assert stats["skipped"] == 1


def test_modified_file_is_updated(dirs):
    src, dst = dirs
    _write(src / "a.json", "v1")
    mirror_backup(src, dst)
    _write(src / "a.json", "v2-longer")
    stats = mirror_backup(src, dst)
    assert stats["copied"] == 1
    assert (dst / "a.json").read_text(encoding="utf-8") == "v2-longer"


def test_same_size_but_newer_mtime_is_updated(dirs):
    """内容长度相同但 mtime 更新（如画布原地改一个字段）也必须重新复制"""
    src, dst = dirs
    _write(src / "a.json", "v1")
    mirror_backup(src, dst)
    _write(src / "a.json", "v2")
    # 强制把源文件 mtime 拨快，避免文件系统时间精度导致漏判
    future = time.time() + 10
    os.utime(src / "a.json", (future, future))
    stats = mirror_backup(src, dst)
    assert stats["copied"] == 1
    assert (dst / "a.json").read_text(encoding="utf-8") == "v2"


def test_deleted_source_file_is_removed_from_backup(dirs):
    src, dst = dirs
    _write(src / "canvases" / "gone.json", "{}")
    _write(src / "canvases" / "stay.json", "{}")
    mirror_backup(src, dst)
    (src / "canvases" / "gone.json").unlink()
    stats = mirror_backup(src, dst)
    assert stats["deleted"] == 1
    assert not (dst / "canvases" / "gone.json").exists()
    assert (dst / "canvases" / "stay.json").exists()


def test_logs_dir_is_excluded(dirs):
    src, dst = dirs
    _write(src / "logs" / "app.log", "log")
    _write(src / "a.json", "{}")
    mirror_backup(src, dst)
    assert not (dst / "logs").exists()
    assert (dst / "a.json").exists()


def test_empty_dirs_in_backup_are_cleaned(dirs):
    src, dst = dirs
    _write(src / "images" / "c1" / "img.jpg", "x")
    mirror_backup(src, dst)
    (src / "images" / "c1" / "img.jpg").unlink()
    mirror_backup(src, dst)
    assert not (dst / "images" / "c1").exists()


def test_missing_source_raises(dirs, tmp_path):
    _, dst = dirs
    with pytest.raises(FileNotFoundError):
        mirror_backup(tmp_path / "nonexistent", dst)


def test_backup_dir_in_source_is_excluded(dirs):
    """源目录里的 backup/ 不参与备份（防止递归复制自身）"""
    src, dst = dirs
    _write(src / "backup" / "old.json", "old")
    _write(src / "a.json", "{}")
    mirror_backup(src, dst)
    assert not (dst / "backup").exists()
    assert (dst / "a.json").exists()


def test_backup_inside_source_does_not_recurse(dirs):
    """真实部署形态：目标就是源内的 backup/ 子目录。
    连续备份两轮，不得出现 backup/backup/... 递归，第二轮全部跳过。"""
    src, _ = dirs
    _write(src / "canvases" / "c1.json", "{}")
    dst = src / "backup"

    stats1 = mirror_backup(src, dst)
    assert stats1["copied"] == 1
    assert (dst / "canvases" / "c1.json").exists()
    assert not (dst / "backup").exists()

    stats2 = mirror_backup(src, dst)
    assert stats2 == {"copied": 0, "deleted": 0, "skipped": 1}
    assert not (dst / "backup").exists()
