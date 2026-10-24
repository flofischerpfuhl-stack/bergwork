import React from 'react';

// Function components have no before-mutation hook. This child reads the old
// page geometry before the same React commit applies the new zoom CSS.
export class ZoomCommitSnapshot extends React.Component {
  getSnapshotBeforeUpdate(previousProps) {
    if (previousProps.zoom !== this.props.zoom) {
      this.props.onBeforeZoomCommit(previousProps.zoom, this.props.zoom);
    }
    return null;
  }
  componentDidUpdate() {}
  render() { return null; }
}
