import { describe, expect, it } from 'vitest';
import { renderUiSurfacePlainText, toolOutput } from '../src/tui/transcript.js';

describe('TUI UiSurface plain-text degradation (T-UIS-06)', () => {
  it('renders aligned text table, steps, and numbered action hints for ui_surface_render', () => {
    const surface = {
      surfaceId: 'ops-queue',
      revision: 3,
      title: 'Pending Field Dispatches',
      resolvedData: {
        items: [
          { id: 'D-01', well: 'BZ-19-6', action: 'Replay Card' },
          { id: 'D-02', well: 'KL-3-2', action: 'Depth Calibrate' },
        ],
      },
      components: [
        {
          kind: 'steps',
          id: 'st',
          steps: [
            { id: '1', label: 'Validate', status: 'done' },
            { id: '2', label: 'Confirm', status: 'active' },
          ],
        },
        {
          kind: 'table',
          id: 'tb',
          dataKey: 'items',
          columns: [
            { key: 'id', label: 'ID' },
            { key: 'well', label: 'Well' },
            { key: 'action', label: 'Action' },
          ],
        },
      ],
      actions: [
        { id: 'confirm_dispatch', label: 'Confirm Selected' },
        { id: 'cancel_dispatch', label: 'Reject' },
      ],
    };

    const plain = renderUiSurfacePlainText({ surface });
    expect(plain).toContain('[Workbench] Pending Field Dispatches (v3)');
    expect(plain).toContain('Steps: Validate[done] -> Confirm[active]');
    expect(plain).toContain('ID | Well | Action');
    expect(plain).toContain('D-01 | BZ-19-6 | Replay Card');
    expect(plain).toContain('[1] Confirm Selected (confirm_dispatch)');

    const viaToolOutput = toolOutput({
      tool: 'ui_surface_render',
      result: { success: true, surface },
    });
    expect(viaToolOutput).toContain('[Workbench] Pending Field Dispatches (v3)');
  });
});
