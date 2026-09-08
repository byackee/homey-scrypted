/**
 * Making Scrypted's answer answer the offer Homey actually made.
 *
 * An SDP answer is not a free-standing description: RFC 3264 requires it to carry the same
 * media sections as the offer, in the same order, so that the two sides can refer to a
 * stream by its position. Homey's player is a browser engine and enforces that to the
 * letter — an answer whose sections arrive in another order is refused outright with
 * "The order of m-lines in answer doesn't match order in offer", and the live view shows
 * only "something went wrong".
 *
 * Scrypted builds its answer from the transceivers its own camera pipeline created, whose
 * order follows the camera rather than the offer. Whenever those two orders disagree the
 * stream cannot start, and nothing in between notices: the answer is well-formed, it simply
 * answers a different question.
 *
 * Re-ordering is safe because a media section is self-describing — it is identified by its
 * `a=mid`, and every reference to it inside the section travels with it. What must move
 * with the sections is the `a=group:BUNDLE` line, which lists mids in order and is checked
 * against them.
 *
 * Kept as a pure function over two strings: it is the one part of the WebRTC path that can
 * be tested without a camera, a server, or a peer connection.
 */

export interface AnswerAlignment {
  /** The answer to hand back, re-ordered only if it had to be. */
  sdp: string;
  /** Whether anything was changed. False means the answer already matched the offer. */
  changed: boolean;
  /** Mids in the offer's order, for tracing. */
  offerMids: string[];
  /** Mids in the answer's original order, for tracing. */
  answerMids: string[];
  /** Why the answer was left alone, when it was left alone despite not matching. */
  note?: string;
}

interface Section {
  lines: string[];
  /** The media type from the `m=` line: video, audio, application. */
  media: string;
  mid?: string;
}

const MID = /^a=mid:(.+)$/;

function midOf(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = MID.exec(line.trim());
    if (match) return match[1]!.trim();
  }
  return undefined;
}

function split(sdp: string): { session: string[]; sections: Section[] } {
  const session: string[] = [];
  const sections: Section[] = [];

  for (const line of sdp.split(/\r?\n/)) {
    // A description ends with a line terminator, so splitting leaves a trailing empty
    // string — and an empty line belongs to whichever section it was written under. Carried
    // through a re-ordering it would land in the middle of the answer, where an empty line
    // is not a line at all: the parser this function exists to satisfy would reject the
    // result for a second reason. Blank lines hold nothing, so none is kept.
    if (!line) continue;
    if (line.startsWith('m=')) {
      sections.push({ lines: [line], media: line.slice(2).split(/\s+/)[0] ?? '' });
    } else if (sections.length) {
      sections[sections.length - 1]!.lines.push(line);
    } else {
      session.push(line);
    }
  }

  for (const section of sections) section.mid = midOf(section.lines);
  return { session, sections };
}

/**
 * A section the answerer declines, written the way an answer must decline one.
 *
 * Dropping a section instead of rejecting it shifts every section after it, which is the
 * same failure this module exists to prevent. A port of zero is what says "not this one",
 * and the `m=` line is otherwise copied from the offer because the answer is not free to
 * choose the protocol it refuses.
 */
function rejectedSection(offerSection: Section): string[] {
  // `m=<media> <port> <protocol> <formats...>`; the port is the one field this replaces.
  const [, , protocol = 'UDP/TLS/RTP/SAVPF', ...formats] = offerSection.lines[0]!.slice(2).split(/\s+/);

  return [
    `m=${offerSection.media} 0 ${protocol} ${formats.join(' ') || '0'}`.trimEnd(),
    'c=IN IP4 0.0.0.0',
    'a=inactive',
    ...(offerSection.mid ? [`a=mid:${offerSection.mid}`] : []),
  ];
}

/**
 * Pairs each offer section with the answer section that replies to it.
 *
 * By mid when both sides label their sections, which is what a browser-generated offer and
 * anything modern answering it will do. Falling back to media type keeps a description that
 * predates `a=mid` — or one whose mids were rewritten — from being mangled instead of left
 * alone; an unmatched section is reported rather than guessed at.
 */
function pair(offer: Section[], answer: Section[]): Section[] | undefined {
  const remaining = [...answer];
  const paired: Section[] = [];

  for (const section of offer) {
    let index = section.mid !== undefined
      ? remaining.findIndex(candidate => candidate.mid === section.mid)
      : -1;
    if (index < 0 && section.mid !== undefined && remaining.some(candidate => candidate.mid !== undefined)) {
      // The answer labels its sections and none of them carries this mid: it declined this
      // media rather than moved it, which `rejectedSection` handles. Matching it to some
      // other section by type here would answer the wrong question.
      paired.push({ lines: rejectedSection(section), media: section.media, mid: section.mid });
      continue;
    }
    if (index < 0) index = remaining.findIndex(candidate => candidate.media === section.media);

    if (index < 0) {
      paired.push({ lines: rejectedSection(section), media: section.media, mid: section.mid });
      continue;
    }

    paired.push(remaining.splice(index, 1)[0]!);
  }

  // The answer carries media the offer never asked for. Re-ordering cannot express that, so
  // the caller is told and the answer is passed through untouched.
  return remaining.length ? undefined : paired;
}

/** Rewrites the BUNDLE group so it lists the same mids the sections now appear in. */
function realignBundle(session: string[], order: Section[]): string[] {
  return session.map(line => {
    if (!line.startsWith('a=group:BUNDLE')) return line;

    const grouped = new Set(line.slice('a=group:BUNDLE'.length).trim().split(/\s+/).filter(Boolean));
    const mids = order
      .map(section => section.mid)
      .filter((mid): mid is string => mid !== undefined && grouped.has(mid));

    return mids.length ? `a=group:BUNDLE ${mids.join(' ')}` : line;
  });
}

/**
 * Returns the answer with its media sections in the offer's order.
 *
 * An answer that already matches is returned byte for byte, so the common case cannot be
 * damaged by this function: nothing is reserialised unless something had to move.
 */
export function alignAnswerToOffer(offerSdp: string, answerSdp: string): AnswerAlignment {
  const offer = split(offerSdp ?? '');
  const answer = split(answerSdp ?? '');

  const offerMids = offer.sections.map(section => section.mid ?? `(${section.media})`);
  const answerMids = answer.sections.map(section => section.mid ?? `(${section.media})`);
  const unchanged = { sdp: answerSdp, changed: false, offerMids, answerMids };

  if (!offer.sections.length || !answer.sections.length) {
    return { ...unchanged, note: 'no media sections to align' };
  }

  const ordered = pair(offer.sections, answer.sections);
  if (!ordered) {
    return { ...unchanged, note: 'the answer carries media the offer did not ask for' };
  }

  const alreadyRight = ordered.length === answer.sections.length
    && ordered.every((section, index) => section === answer.sections[index]);
  if (alreadyRight) return unchanged;

  const eol = answerSdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = [...realignBundle(answer.session, ordered), ...ordered.flatMap(section => section.lines)];
  // Every line was stripped of its terminator by the split, including the last one.
  const sdp = lines.join(eol) + eol;

  return { sdp, changed: true, offerMids, answerMids };
}
