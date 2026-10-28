// Composition root: ports + controller are created exactly once per JS runtime, outside
// React. A render-time effect could run twice (StrictMode, remounts) and create two controllers
// polling and uploading in parallel; a module-level singleton cannot.

import { AppState } from 'react-native';

import {
  appSwitcherCoverEnabled,
  createExpoPorts,
  explicitAnnouncements,
  pickStatementFile,
} from '../adapters';
import {
  createImportController,
  type ImportController,
  type LoggerPort,
  type PickedFile,
} from '../core';
import { readAppConfig } from './config';
import { installGlobalErrorHandler, type ErrorUtilsLike } from './globalErrors';
import { createLifecycleBridge } from './lifecycle';

export type AppServices =
  | {
      readonly kind: 'ready';
      readonly controller: ImportController;
      readonly pickFile: () => Promise<PickedFile | null>;
      readonly diagnosticsEnabled: boolean;
      readonly coverEnabled: boolean;
      /** iOS: announce changes explicitly (no live regions). */
      readonly announceChanges: boolean;
      readonly logger: LoggerPort;
    }
  /** EXPO_PUBLIC_MOCK_URL is malformed: nothing is started, a neutral screen says so. */
  | { readonly kind: 'config_error'; readonly coverEnabled: boolean; readonly logger: LoggerPort };

let services: AppServices | null = null;

/** Idempotent: the first call composes and starts the app, later calls return the same objects. */
export function getAppServices(): AppServices {
  services ??= compose();
  return services;
}

function compose(): AppServices {
  const ports = createExpoPorts();
  // Before anything else runs: an uncaught error never reaches a log or crash report with its text.
  installGlobalErrorHandler(
    (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils,
    ports.logger,
  );
  const config = readAppConfig();
  if (!config.ok) {
    ports.logger.log({ event: 'config_error', cause: 'config_error' });
    return { kind: 'config_error', coverEnabled: appSwitcherCoverEnabled, logger: ports.logger };
  }

  const controller = createImportController({ ...ports, baseUrl: config.value.baseUrl });
  // Lives as long as the JS runtime, like the controller; never removed.
  AppState.addEventListener('change', createLifecycleBridge(controller));
  // Cold start: journal load, orphan sweep, recovery of the active op. Never rejects by contract.
  controller.start().catch(() => undefined);

  return {
    kind: 'ready',
    controller,
    pickFile: pickStatementFile,
    diagnosticsEnabled: config.value.diagnosticsEnabled,
    coverEnabled: appSwitcherCoverEnabled,
    announceChanges: explicitAnnouncements,
    logger: ports.logger,
  };
}
