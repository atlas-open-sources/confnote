"""PayPal sandbox checkout in a popup: reach the guest card form (whichever layout PayPal serves) and pay.

Uses PayPal's published sandbox test Visa and a made-up example.org guest; never a real card or address.
"""

import re

from playwright.sync_api import Page

GUEST_STEPS = 12


def to_card_form(popup: Page, guest_email: str, pause_ms: int) -> list[str]:
    """Click through PayPal's guest path until #cardNumber shows; returns the steps taken (for the log)."""
    steps = []
    for _ in range(GUEST_STEPS):
        if popup.locator("#cardNumber:visible").count():
            return steps
        continue_to_payment = popup.get_by_role(
            "button", name=re.compile(r"Continue to Payment", re.I)
        )
        card_button = popup.get_by_role(
            "button", name=re.compile(r"Pay (with|by) Debit or Credit Card", re.I)
        )
        create_account = popup.locator("#createAccount:visible")
        next_button = popup.locator("#btnNext:visible")
        if continue_to_payment.count() and continue_to_payment.first.is_visible():
            popup.locator(
                "input[type=email]:visible, input[name*=email]:visible, #email:visible"
            ).first.fill(guest_email)
            popup.wait_for_timeout(pause_ms)
            continue_to_payment.first.click()
            steps.append("continue-to-payment")
        elif card_button.count() and card_button.first.is_visible():
            popup.wait_for_timeout(
                max(pause_ms, 1500)
            )  # the button is drawn before its handler is wired
            card_button.first.click()
            steps.append("card-button")
        elif create_account.count():
            popup.wait_for_timeout(max(pause_ms, 1500))
            create_account.first.click()
            steps.append("create-account")
        elif next_button.count() and popup.locator("#email:visible").count():
            popup.locator("#email:visible").fill(guest_email)
            next_button.click()
            steps.append("email-next")
        popup.wait_for_timeout(2500)
    raise TimeoutError(f"PayPal card form not reached after {steps}")


TEST_CARD = {
    "number": "4111111111111111",
    "expiry": "1230",
    "cvv": "123",
}  # PayPal's published sandbox test Visa
BILLING = {
    "#firstName": "Demo",
    "#lastName": "Buyer",
    "#billingLine1": "1 Market St",
    "#billingCity": "San Francisco",
    "#billingPostalCode": "94105",
    "#phone": "4155550100",
}
PAY_BUTTON = re.compile(
    r"^(Pay now as guest|Continue as guest|Pay Now|Continue|Agree (and|&) (continue|pay).*)$", re.I
)


def pay_as_guest(popup: Page, guest_email: str, typing_ms: int) -> None:
    """Fill the guest card form with the test card and press Pay (the popup closes or lingers once PayPal approves)."""
    popup.select_option("#country", "US")
    popup.wait_for_timeout(1500)
    popup.locator("#cardNumber").type(TEST_CARD["number"], delay=typing_ms)
    popup.locator("#cardExpiry").type(TEST_CARD["expiry"], delay=typing_ms)
    popup.locator("#cardCvv").type(TEST_CARD["cvv"], delay=typing_ms)
    for selector, value in BILLING.items():
        popup.fill(selector, value)
    popup.select_option("#billingState", "CA")
    if popup.locator("#email").input_value() == "":
        popup.fill("#email", guest_email)
    if popup.get_by_role("button", name=re.compile(r"Create Account & Pay Now", re.I)).count():
        # One layout defaults to "Save info & create your PayPal account"; a guest turns it off.
        popup.evaluate("""() => {
            const hit = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /create your PayPal account/i.test(e.textContent));
            let box = hit; for (let i = 0; i < 6 && box; i++) { const input = box.querySelector && box.querySelector('input[type=checkbox], [role=switch]'); if (input) { input.click(); return; } box = box.parentElement; }
        }""")
        popup.wait_for_timeout(1500)
    popup.get_by_role("button", name=PAY_BUTTON).first.click(timeout=15_000)
