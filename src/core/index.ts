// Public surface of the functional core for the UI and the composition root.
//
// Usage (src/main):
//   const controller = createImportController({ baseUrl, http, upload, files, store, clock, ids, logger });
//   void controller.start();                       // once, outside React effects
//   AppState → controller.onForeground() / controller.onBackground()
//
// Usage (src/ui):
//   const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
//   switch (snap.view.tag) { ... }                 // exhaustive; one branch per state
//   snap.actions.*                                 // which buttons are enabled right now
//   snap.readError !== null                        // label the status "Last known status"
//   snap.notice                                    // config_error / file_missing / cancel_too_late / client_error
//   snap.diagnostics                               // last raw view, ignored views, local size
//   controller.diagnostics.*                       // /__test routes (dev only)
//
// Snapshots are frozen and replaced on every change (stable identity between changes).

export type {
  AvailableActions,
  ControllerConfig,
  ControllerDeps,
  DiagnosticsSnapshot,
  DraftView,
  ImportController,
  ImportDiagnostics,
  ImportSnapshot,
  ImportView,
  OperationView,
  PrepareError,
} from './controller';
export { createImportController } from './controller';

export type {
  DeleteFailureCause,
  FileFormat,
  JobId,
  JobStatus,
  LocalRejection,
  LookupState,
  MockMode,
  OpId,
  Operation,
  Phase,
  PhaseTag,
  ReadyItem,
  ReadyResult,
  ServerJobView,
  ServerStatus,
  TransportCause,
  UnknownOutcomeCause,
} from './domain';
export { MOCK_MODES, assertNever } from './domain';

export type { IgnoredView, IgnoreReason, Notice, RawView, ReadError, ViewSource } from './machine';
export type { ApiError, MockState, MockStats } from './api';

export type {
  ClockPort,
  CopyError,
  CorePorts,
  FileError,
  FilesPort,
  HttpPort,
  HttpRequest,
  HttpResponse,
  IdsPort,
  PickedFile,
  StoredRow,
  StoreError,
  StorePort,
  TimerHandle,
  TransportError,
  UploadPort,
  UploadProgress,
  UploadRequest,
} from './ports';

export type { LogCause, LogEntry, LogEvent, LoggerPort } from './log';
export { createLogger, sanitizeLogEntry, silentLogger } from './log';

export type { Result } from './result';
export { err, ok } from './result';

export {
  formatCadence,
  formatDate,
  formatFileFormat,
  formatItemLine,
  formatMoney,
  formatMonthlyTotal,
  formatPercent,
  formatSize,
  monthlyTotalMinor,
} from './format';

export { HEADER_BYTES, MAX_FILE_BYTES, detectFormat } from './validate';
