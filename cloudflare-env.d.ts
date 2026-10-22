declare namespace Cloudflare {
  interface Env {
    CONTROL_ROOM_MANUAL_SITES_WINDOW?: string;
    CONTROL_ROOM_PERSONAL_CONNECTOR?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
