/**
 * Declarative structured workspace surface (v1) bounded to 6 closed component kinds, 64 KiB payload size, and 500 table rows. Supports read-only server data bindings ($source) verified via SHA-256 sourceHashes prior to any action dispatch.
 */
export interface UiSurfacePayload {
  surfaceId: string;
  title: string;
  subtitle?: string;
  revision: number;
  placement?: "inline" | "workbench";
  /**
   * Static data or $source binding descriptors ({ "$source": "namespace/query", "params": {...} }).
   */
  data?: {
    [k: string]: any;
  };
  /**
   * Host-evaluated read-only data snapshot corresponding to `data`.
   */
  resolvedData?: {
    [k: string]: any;
  };
  /**
   * Canonical JSON SHA-256 hex digest per data key bound via $source.
   */
  sourceHashes?: {
    [k: string]: string;
  };
  staleKeys?: string[];
  /**
   * @minItems 1
   * @maxItems 24
   */
  components: [
    {
      id: string;
      kind: "table" | "detail-card" | "form" | "steps" | "kv-diff" | "artifact-card";
      title?: string;
      dataKey?: string;
      rowIdField?: string;
      selectable?: boolean;
      columns?: {
        key: string;
        label: string;
        align?: "left" | "center" | "right";
        [k: string]: any;
      }[];
      /**
       * @maxItems 500
       */
      rows?: {
        [k: string]: any;
      }[];
      fields?: {
        key: string;
        label: string;
        type?: "text" | "number" | "select" | "textarea" | "checkbox";
        required?: boolean;
        options?: string[];
        value?: any;
        [k: string]: any;
      }[];
      steps?: {
        id: string;
        label: string;
        detail?: string;
        status: "pending" | "active" | "completed" | "failed";
        [k: string]: any;
      }[];
      diffs?: {
        key: string;
        label?: string;
        before?: any;
        after?: any;
        [k: string]: any;
      }[];
      artifact?: {
        name?: string;
        path?: string;
        mimeType?: string;
        sha256?: string;
        sizeBytes?: number;
        downloadUrl?: string;
        [k: string]: any;
      };
      [k: string]: any;
    },
    ...{
      id: string;
      kind: "table" | "detail-card" | "form" | "steps" | "kv-diff" | "artifact-card";
      title?: string;
      dataKey?: string;
      rowIdField?: string;
      selectable?: boolean;
      columns?: {
        key: string;
        label: string;
        align?: "left" | "center" | "right";
        [k: string]: any;
      }[];
      /**
       * @maxItems 500
       */
      rows?: {
        [k: string]: any;
      }[];
      fields?: {
        key: string;
        label: string;
        type?: "text" | "number" | "select" | "textarea" | "checkbox";
        required?: boolean;
        options?: string[];
        value?: any;
        [k: string]: any;
      }[];
      steps?: {
        id: string;
        label: string;
        detail?: string;
        status: "pending" | "active" | "completed" | "failed";
        [k: string]: any;
      }[];
      diffs?: {
        key: string;
        label?: string;
        before?: any;
        after?: any;
        [k: string]: any;
      }[];
      artifact?: {
        name?: string;
        path?: string;
        mimeType?: string;
        sha256?: string;
        sizeBytes?: number;
        downloadUrl?: string;
        [k: string]: any;
      };
      [k: string]: any;
    }[]
  ];
  actions?: {
    id: string;
    label: string;
    toolName: string;
    dataKey?: string;
    variant?: "primary" | "secondary" | "danger";
    checkpoint?: "standard" | "outward";
    requiresSelection?: boolean;
    staticArgs?: {
      [k: string]: any;
    };
    [k: string]: any;
  }[];
  [k: string]: any;
}
