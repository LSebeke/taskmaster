import { Component, type ComponentChildren } from 'preact';

interface GuardState {
  error: string | null;
}

/** Holds a render error inside one part of the view, says so there, and tries again on the next render from outside. */
export class Guard extends Component<{ children?: ComponentChildren }, GuardState> {
  override state: GuardState = { error: null };

  static override getDerivedStateFromError(e: unknown): GuardState {
    return { error: String(e) };
  }

  override componentDidCatch(e: unknown) {
    console.error('Taskmaster: a part of the view failed to render', e);
  }

  override componentWillReceiveProps() {
    if (this.state.error) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return <>{this.props.children}</>;
    return (
      <div class="tm-guard">
        ⚠ This part failed to draw and stays off until the next change. <span class="tm-small">{this.state.error}</span>
      </div>
    );
  }
}
