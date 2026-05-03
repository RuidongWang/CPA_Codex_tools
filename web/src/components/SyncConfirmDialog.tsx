interface SyncConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onBackupThenSync: () => void;
  onSyncWithoutBackup: () => void;
}

// 同步前确认单独成弹层，避免把下载备份决策塞进按钮禁用态里让用户摸不着原因。
export function SyncConfirmDialog(props: SyncConfirmDialogProps) {
  if (!props.open) {
    return null;
  }

  return (
    <div className="settings-dialog__backdrop" role="presentation">
      <section className="settings-dialog settings-dialog--compact" role="dialog" aria-modal="true" aria-label="同步前确认">
        <header className="settings-dialog__header">
          <div>
            <h2>同步前确认</h2>
          </div>
          <button type="button" className="settings-dialog__ghost" onClick={props.onClose}>
            关闭
          </button>
        </header>
        <div className="settings-dialog__body">
          <section className="settings-section">
            <div className="settings-section__hint settings-section__hint--stacked">
              <span>当前检测到本地优先级草稿还没有对应的新下载备份。</span>
              <span>先下载全部账号文件更稳。也可以在确认已下载后直接同步到远端。</span>
            </div>
          </section>
        </div>
        <footer className="settings-dialog__footer">
          <button type="button" className="command-button" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="command-button" onClick={props.onSyncWithoutBackup}>
            我已下载，直接同步
          </button>
          <button type="button" className="command-button command-button--primary" onClick={props.onBackupThenSync}>
            先下载全部再同步
          </button>
        </footer>
      </section>
    </div>
  );
}
