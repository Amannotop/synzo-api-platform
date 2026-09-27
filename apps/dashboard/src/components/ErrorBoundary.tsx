import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button, Card } from './ui';

/**
 * Without this, any exception thrown while rendering a page unmounts the whole
 * React tree and leaves a blank white document — including the sidebar, so the
 * user has no navigation left to recover with. A page that fails to render
 * must still leave the app usable.
 */
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The dashboard is the operator's only view of a running platform, so a
    // silent white page is the worst possible failure mode. Log loudly.
    console.error('Dashboard render failed', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="auth-wrap">
        <Card title="This page could not be displayed">
          <Alert kind="error">
            Something went wrong while rendering this page. Your data and keys are
            unaffected.
          </Alert>
          <p className="small subtle mt-2" style={{ wordBreak: 'break-word' }}>
            {error.message}
          </p>
          <div className="row mt-3">
            <Button variant="primary" onClick={() => { window.location.href = '/'; }}>
              Back to dashboard
            </Button>
            <Button onClick={this.reset}>Try again</Button>
          </div>
        </Card>
      </div>
    );
  }
}
