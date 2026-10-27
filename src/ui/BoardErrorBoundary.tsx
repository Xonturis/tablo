import { Component, type ReactNode } from "react";

/** If a board fails to render, offer to reload it instead of leaving a frozen canvas. */
export class BoardErrorBoundary extends Component<{ children: ReactNode; boardName: string }, { error: Error | null; attempt: number }> {
  state = { error: null as Error | null, attempt: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Board crashed:", error);
  }

  render() {
    if (!this.state.error) return <div key={this.state.attempt} className="board-host">{this.props.children}</div>;
    return (
      <div className="splash">
        <div className="board-error">
          <h2>“{this.props.boardName}” couldn’t be displayed</h2>
          <p className="muted small">Your data is safe: it is stored on this device and with your collaborators.</p>
          <code className="small">{this.state.error.message}</code>
          <div className="row">
            <button className="primary" onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}>Reload this board</button>
            <button onClick={() => location.reload()}>Reload the app</button>
          </div>
        </div>
      </div>
    );
  }
}
