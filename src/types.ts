export interface FeedItem {
  item_id: string;
  summary?: string;
  broadcast_type: string;
  domains?: string[];
  keywords?: string[];
  group_id?: string;
  source_type?: string;
  url?: string;
  updated_at: number;
}

export interface FeedNotification {
  notification_id: string;
  type: string;
  content: string;
  created_at: number;
}

export interface FeedResponse {
  code: number;
  msg: string;
  data: {
    items: FeedItem[];
    has_more: boolean;
    notifications: FeedNotification[];
    /**
     * Output-contract digest delivered inline by the backend. When present it is
     * surfaced as a leading prose block so the binding output rules reach the
     * agent without depending on it loading the ef-broadcast skill.
     */
    output_contract?: string;
  };
}
