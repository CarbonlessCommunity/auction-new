/**
 * Shared types for the event-sourced auction model. These describe the wire
 * contract between server and client and are imported by both sides.
 *
 * The core idea (ported from the original auction-machine): an auction is a
 * append-only log of `AuctionEvent`s. The server is the sole authority on
 * what gets appended (after running inbound validation) and on what a given
 * viewer is allowed to see (outbound filtering, e.g. blind last-call bids).
 * Clients derive all UI state by folding the event log, same as before.
 */

export type Role = 'owner' | 'bidder' | 'viewer';

/** 'reverse' = lowest bid wins (procurement-style, the original's only mode).
 *  'forward' = highest bid wins (classic auction). Configurable per auction. */
export type BidDirection = 'reverse' | 'forward';

export interface AuctionConfig {
  bidDirection: BidDirection;
  /** Base auction duration, in seconds, before any extensions. */
  auctionLengthSec: number;
  /**
   * When a leading bid arrives with remaining time inside
   * (lastCallSec, extendedTimeThresholdSec), the clock resets so remaining
   * time becomes exactly extendedTimeThresholdSec again ("Extended Time").
   */
  extendedTimeThresholdSec: number;
  /** Length of the blind bidding window right after the clock hits zero. */
  lastCallSec: number;
  /**
   * How many leading suppliers may still bid on a lot once Last Call opens.
   * 0 turns the restriction off and lets everyone keep bidding.
   */
  lastCallBidders: number;
  /** Minimum required improvement over the current best bid (0 = any strictly better bid). */
  minBidStep: number;
}

export type EventType =
  | 'setName'
  | 'addUser'
  | 'addLot'
  | 'renameLot'
  | 'placeBid'
  | 'cancelBid'
  | 'startAuction'
  | 'showResults';

/** A stored/broadcast event. Canonical (server-enriched) shape; individual
 *  fields beyond the common ones vary by `type` (see Input types below). */
export interface AuctionEvent {
  type: EventType;
  seq: number;
  time: number;
  [key: string]: unknown;
}

export interface SetNameInput {
  type: 'setName';
  name: string;
}

export interface AddUserInput {
  type: 'addUser';
  name: string;
  role: Role;
  email?: string;
}

export interface AddLotInput {
  type: 'addLot';
  name: string;
}

export interface RenameLotInput {
  type: 'renameLot';
  lotId: string;
  name: string;
}

export interface PlaceBidInput {
  type: 'placeBid';
  lotId: string;
  value: number;
  /** Set by an owner placing a bid on a bidder's behalf. */
  onBehalfOfPublicKey?: string;
}

export interface CancelBidInput {
  type: 'cancelBid';
  /** `seq` of the placeBid event being cancelled. */
  bidSeq: number;
}

export interface StartAuctionInput {
  type: 'startAuction';
}

export interface ShowResultsInput {
  type: 'showResults';
}

export type InboundEventInput =
  | SetNameInput
  | AddUserInput
  | AddLotInput
  | RenameLotInput
  | PlaceBidInput
  | CancelBidInput
  | StartAuctionInput
  | ShowResultsInput;

export interface UserView {
  publicKey: string;
  role: Role;
  name: string;
}

export interface BidView {
  seq: number;
  lotId: string;
  bidder: string;
  value: number;
  time: number;
}

export interface LotView {
  id: string;
  name: string;
  insertionOrder: number;
  bids: BidView[];
}

export interface AuctionPhase {
  isRunning: boolean;
  isInExtendedTime: boolean;
  isInLastCall: boolean;
  isCompleted: boolean;
  startTime: number | null;
  auctionLength: number;
  remainingSec: number;
}

export interface AuctionStateView {
  id: string;
  name: string;
  config: AuctionConfig;
  users: UserView[];
  lots: LotView[];
  phase: AuctionPhase;
  showResultsReleased: boolean;
  serverTime: number;
  you: UserView;
}

export interface AuctionMeta {
  id: string;
  name: string;
  config: AuctionConfig;
}

/**
 * Server → client messages. The server pushes a full (outbound-filtered)
 * snapshot on connect and after results are released — the successor to the
 * original's `refreshTo` full-reload trick — then streams deltas.
 */
export type ServerMessage =
  | { kind: 'snapshot'; auction: AuctionMeta; you: UserView; events: AuctionEvent[]; serverTime: number }
  | { kind: 'event'; event: AuctionEvent; serverTime: number }
  | { kind: 'error'; message: string };
