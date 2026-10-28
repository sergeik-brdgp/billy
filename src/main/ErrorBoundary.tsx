// Last-resort boundary around the import screen. A render crash shows a neutral Russian message
// instead of a white screen; the controller (outside React) keeps the operation, its key and the
// journal untouched, so "Try again" simply re-renders from the current snapshot.

import { Component, type ErrorInfo, type ReactNode } from 'react';

import type { LoggerPort } from '../core';
import { FallbackScreen } from '../ui';

export interface AppErrorBoundaryProps {
  readonly logger: LoggerPort;
  readonly children: ReactNode;
}

interface State {
  readonly failed: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // Allow-listed event only: the error message / stack could quote file or merchant data.
    this.props.logger.log({ event: 'invariant_violation', cause: 'unexpected' });
  }

  private readonly retry = (): void => {
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    if (this.state.failed) return <FallbackScreen variant="crash" onRetry={this.retry} />;
    return this.props.children;
  }
}
