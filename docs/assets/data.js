/* Static reference data for CallGuard: fraud categories, alert wording, plans, demo service responses. */
window.CG_DATA = {
  categories: {
    F0: { name: "Not fraud", banking: false, risk: "low",
          advice: "No scam pattern was found. No alerts were sent." },
    F1: { name: "Financial impersonation", banking: true, risk: "high",
          advice: "The caller pretended to be a bank or payment provider. Do not share OTPs, PINs or card details. Call the bank on the number printed on your card." },
    F2: { name: "Account takeover", banking: true, risk: "high",
          advice: "The caller tried to get login codes or change account access. Change passwords, sign out other sessions and ask the bank to freeze transfers." },
    F3: { name: "Government impersonation", banking: false, risk: "high",
          advice: "Government agencies do not demand payment over the phone, by gift card or crypto. Hang up and contact the agency through its official website." },
    F4: { name: "Tech support / business impersonation", banking: false, risk: "high",
          advice: "Do not install remote-access apps or pay for 'fixes'. Real companies do not cold-call about viruses or refunds." },
    F5: { name: "Romance / catfishing", banking: false, risk: "medium",
          advice: "Someone met online is asking for money or secrecy. Never send money to a person you have not met; talk to someone you trust." },
    F6: { name: "Pig-butchering / investment", banking: false, risk: "high",
          advice: "Guaranteed returns and 'withdrawal fees' are signs of an investment scam. Do not deposit more money to unlock funds." },
    F7: { name: "Honeytrap / sextortion", banking: false, risk: "high",
          advice: "Do not pay or keep talking. Save the evidence, block the caller and report it. Paying rarely stops the threats." },
    F8: { name: "Family emergency / voice clone", banking: false, risk: "high",
          advice: "The voice may be cloned. Hang up and call the family member back on their known number before sending anything." },
    F9: { name: "Prize / job / advance-fee", banking: false, risk: "medium",
          advice: "Real prizes and jobs never ask for an upfront fee. Do not pay processing, registration or release charges." },
  },

  plans: [
    { id: "free", name: "Starter", price: 0, calls: 50, tagline: "For individuals trying it out",
      features: ["50 analysed calls / month", "All 10 fraud categories", "Nominee + emergency alerts", "30-day history"] },
    { id: "pro", name: "Family Pro", price: 9, calls: 1000, tagline: "For households and caregivers",
      features: ["1,000 analysed calls / month", "Bank fraud-desk emails", "Up to 5 authorised people", "Unlimited history + local folder sync", "CSV / JSON export"] },
    { id: "business", name: "Business", price: 49, calls: 20000, tagline: "For banks, telcos and call centres",
      features: ["20,000 calls / month", "Bring your own transcriber + model endpoints", "Webhook & email notifier", "Team workspaces", "Priority support"] },
  ],

};
