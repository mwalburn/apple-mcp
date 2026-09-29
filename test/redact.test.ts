import { describe, it, expect } from "vitest";
import { redact } from "../src/modules/messages/redact.js";

describe("redaction", () => {
  const cases: [string, string][] = [
    ["Username: walburns\npassword: hunter2!x", "Username: walburns\npassword: [redacted]"],
    ["the wifi Password is CorrectHorse9", "the wifi Password is [redacted]"],
    ["PIN - 4821", "PIN - [redacted]"],
    ["Your Chase verification code is 482913. Do not share it.", "Your Chase verification code is [redacted]. Do not share it."],
    ["Use 30419 as your Apple ID code", "Use [redacted] as your Apple ID code"],
    ["2FA: 8841", "2FA: [redacted]"],
    ["Your one-time passcode is 5566 7788", "Your one-time passcode is [redacted] [redacted]"],
    ["Your Uber code is 1234. Reply STOP to unsubscribe", "Your Uber code is [redacted]. Reply STOP to unsubscribe"],
    ["OTP 482913 expires in 10 minutes", "OTP [redacted] expires in 10 minutes"],
    ["card 4111 1111 1111 1111 exp 04/29", "card [redacted] exp 04/29"],
    ["ssn 123-45-6789", "ssn [redacted]"],
    ["https://share.1password.com/s#AbC-dEf_123456", "https://share.1password.com/[redacted]"],
    ["here: https://send.bitwarden.com/#xYz/abc thanks", "here: https://send.bitwarden.com/[redacted] thanks"],
  ];
  it.each(cases)("masks %j", (input, want) => expect(redact(input)).toEqual({ text: want, redacted: true }));

  const untouched = [
    "Pick him up at 5:30, 3175 Century Ave S",          // times and street numbers are not codes
    "Tuition is $11,200 due 9/21",                      // money and dates
    "Call me at 651-555-0100",                          // phone numbers
    "I passed the exam! Got 1450",                      // "pass" inside a word, number not a code context
    "Can you please send me the password once you reset it?", // asks about a password, contains none
    "https://www.icloud.com/notes/0a7OBCKKiu1Y#Costco",         // ordinary shared links are not secrets
    "https://www.masterboltz.com/user/login",
    "Login is at 1600 Pennsylvania Ave, see you in 2026", // "login" alone is not a code context
    "Can you verify the invoice total is 12500?",        // nor is "verify"
    "Sign in opens at 0900",
    "Flight code is DL1234, gate B12",                    // digits glued to letters are not codes
    "The discount code saves you $1500",                  // currency is not a code
  ];
  it.each(untouched)("leaves %j alone", (t) => expect(redact(t)).toEqual({ text: t, redacted: false }));
});
