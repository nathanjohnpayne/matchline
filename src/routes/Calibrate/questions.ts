import type { CardType } from "../../lib/labelDeck/deck.ts";

/** Chip text and the question each card type asks. */
export const QUESTIONS: Record<CardType, { chip: string; question: string }> = {
  "fact-correct": { chip: "Fact correct?", question: "Is this a true fact from the résumé?" },
  verbatim: { chip: "Verbatim?", question: "Is the raw_text a quote from one résumé line?" },
  "keep-unmatched-unit": { chip: "Keep extra Unit?", question: "Is this a real résumé fact the labels missed, not a duplicate or a non-fact?" },
  "requirement-equivalent": { chip: "Same requirement?", question: "Does the parsed requirement say the same thing as the expected one?" },
  "must-have-right": { chip: "Must-have right?", question: "Is the parsed must-have / nice-to-have flag right for this JD line?" },
  "keep-unmatched-requirement": { chip: "Keep extra requirement?", question: "Is this a real JD requirement the labels missed, not a duplicate or a split?" },
  "match-pair-agree": { chip: "Still agree?", question: "Does this résumé fact answer this requirement?" },
};
