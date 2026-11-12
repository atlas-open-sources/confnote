"""Web wallet UI: balance in the account menu, the 402 buy-more card in the
Concierge, and the pack picker paying through a stubbed PayPal JS SDK v6.

Every web API the shell needs is intercepted, so the local server only serves
the static app. Set CONFNOTE_WALLET_SHOTS to a folder to save screenshots.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from conftest import answer_settings_as_web
from test_chat_retry import _open_chat, _send

PACKS = [
    {
        "sku": f"pack-{usd}",
        "credits": str(usd * 1000000),
        "price": {"amountMinor": str(usd * 100), "currency": "USD"},
    }
    for usd in (5, 10, 25)
]

FAKE_PAYPAL_SDK = """
customElements.define("paypal-button", class extends HTMLElement {
  connectedCallback() { this.textContent = "PayPal"; this.style.display = "block"; }
});
window.paypal = {
  createInstance: async (options) => {
    window.__paypalOptions = options;
    return {
      // window.__paypalFlow: "approve" (default), "approve-then-cancel" (the popup closes late, while the
      // capture runs) or "cancel" (the popup closes before PayPal reports the approval).
      createPayPalOneTimePaymentSession: (handlers) => ({
        start: async (_presentation, order) => {
          const { orderId } = await order;
          const flow = window.__paypalFlow || "approve";
          if (flow === "cancel") return handlers.onCancel();
          const approved = handlers.onApprove({ orderId });
          if (flow === "approve-then-cancel") await handlers.onCancel();
          return approved;
        },
      }),
    };
  },
};
"""


def _shot(page, name):
    folder = os.environ.get("CONFNOTE_WALLET_SHOTS")
    if folder:
        Path(folder).mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(Path(folder) / name))


@pytest.fixture
def wallet_page(confnote_server, page, chat_reset):
    state = {
        "available": 0,
        "checkout": [],
        "capture": [],
        "client_id": "sandbox-client",
        "approve_url": "https://www.sandbox.paypal.com/checkoutnow?token=ORDER10",
    }

    def fulfill(route, body, status=200):
        route.fulfill(status=status, content_type="application/json", body=json.dumps(body))

    def me(route, request):
        fulfill(
            route,
            {
                "userId": "u1",
                "email": "fixture@example.test",
                "workspaceId": "w1",
                "entitlements": {"plan": "free"},
            },
        )

    def wallet(route, request):
        available = state["available"]
        fulfill(
            route,
            {
                "balance": available,
                "reserved": 0,
                "available": available,
                "buyMoreUrl": "https://confnote.test/buy",
                "unit": "usd_micros",
            },
        )

    def checkout(route, request):
        state["checkout"].append(request.post_data_json)
        fulfill(
            route,
            {
                "provider": "paypal",
                "orderId": "ORDER10",
                "approveUrl": state["approve_url"],
                "sku": "pack-10",
                "credits": "10000000",
                "price": {"amountMinor": "1000", "currency": "USD"},
            },
        )

    def capture(route, request):
        state["capture"].append(request.post_data_json)
        if state.get("capture_status"):
            fulfill(
                route, {"error": "The payment could not be completed."}, state["capture_status"]
            )
            return
        state["available"] = 10000000
        fulfill(route, {"status": "captured", "paymentIds": ["pay-1"]})

    def chat(route, request):
        lines = [
            {
                "error": "You are out of credits. Add credits to continue.",
                "status": 402,
                "buyMoreUrl": "https://confnote.test/buy",
                "available": 0,
                "required": 40000,
                **({"autoTopUp": state["auto_top_up"]} if state.get("auto_top_up") else {}),
            },
            {"done": True},
        ]
        route.fulfill(
            status=200,
            content_type="application/x-ndjson",
            body="".join(json.dumps(line) + "\n" for line in lines),
        )

    page.route("**/api/me", me)
    page.route(
        "**/api/workspaces",
        lambda route, request: fulfill(route, [{"id": "w1", "name": "Personal"}]),
    )
    page.route("**/api/wallet", wallet)
    page.route(
        "**/api/wallet/packs",
        lambda route, request: fulfill(
            route,
            {"packs": PACKS, "paypal": {"clientId": state["client_id"], "environment": "sandbox"}},
        ),
    )
    page.route("**/api/wallet/checkout", checkout)
    page.route("**/api/wallet/capture", capture)
    page.route("**/api/chat/global*", chat)
    page.route(
        "https://www.sandbox.paypal.com/web-sdk/v6/core",
        lambda route, request: route.fulfill(
            status=200, content_type="text/javascript", body=FAKE_PAYPAL_SDK
        ),
    )
    answer_settings_as_web(page)
    page.emulate_media(color_scheme="dark")
    page.goto(confnote_server + "/#/")
    page.wait_for_selector("#sidebar .sb-conf")
    return page, state


def _buy_ten(page, state):
    _open_chat(page)
    _send(page, "summarise the day")
    card = page.locator(".wallet-card")
    card.wait_for()
    assert "Available $0.00 · this step needs $0.04" in card.inner_text()
    _shot(page, "wallet-402-card.png")
    card.locator(".wallet-buy").click()
    packs = card.locator(".wallet-pack")
    packs.first.wait_for()
    assert packs.count() == 3
    assert "$10.00" in packs.nth(1).inner_text()
    # Sandbox payments say so where people pay (musa, 2026-11-12: sandbox on every host through judging).
    test_mode = card.locator(".wallet-test-mode")
    assert test_mode.inner_text() == "Test payments: PayPal sandbox, no real money"
    packs.nth(1).click()
    pay = card.locator("paypal-button")
    pay.wait_for()
    # Payment stays off until the no-refund / immediate-delivery consent is ticked.
    assert pay.get_attribute("aria-disabled") == "true"
    assert pay.get_attribute("disabled") is not None
    pay.dispatch_event("click")
    assert state["checkout"] == []
    assert card.locator(".wallet-consent a").get_attribute("href") == "/terms"
    _shot(page, "wallet-pack-picker.png")
    card.locator("#wallet-consent").check()
    assert pay.get_attribute("aria-disabled") == "false"
    _shot(page, "wallet-consent-ticked.png")
    pay.click()
    page.wait_for_function(
        "() => document.querySelector('.wallet-card')?.textContent.includes('Credits added')"
    )
    assert len(state["checkout"]) == 1
    assert state["checkout"][0]["sku"] == "pack-10"
    assert state["checkout"][0]["consent"]["accepted"] is True
    assert state["checkout"][0]["consent"]["at"].endswith("Z")
    assert state["capture"] == [{"orderId": "ORDER10"}]
    assert page.evaluate("() => window.__paypalOptions.clientId") == "sandbox-client"


def test_402_card_picker_capture_updates_balance(wallet_page):
    page, state = wallet_page
    page.set_viewport_size({"width": 1400, "height": 900})
    summary = page.locator(".product-account summary")
    summary.click()
    page.wait_for_function(
        "() => document.querySelector('#account-balance')?.textContent === 'AI credits: $0.00'"
    )
    summary.click()
    _buy_ten(page, state)
    summary.click()
    page.wait_for_function(
        "() => document.querySelector('#account-balance')?.textContent === 'AI credits: $10.00'"
    )
    _shot(page, "wallet-balance.png")


def test_wallet_ui_fits_mobile_width(wallet_page):
    page, state = wallet_page
    page.set_viewport_size({"width": 390, "height": 844})
    _buy_ten(page, state)
    width = page.evaluate(
        "() => document.querySelector('.wallet-card').getBoundingClientRect().right"
    )
    assert width <= 390
    _shot(page, "wallet-mobile.png")


def _pay_ten_with(page, flow):
    page.set_viewport_size({"width": 1400, "height": 900})
    page.evaluate("(flow) => { window.__paypalFlow = flow; }", flow)
    _open_chat(page)
    _send(page, "summarise the day")
    card = page.locator(".wallet-card")
    card.locator(".wallet-buy").click()
    card.locator(".wallet-pack").nth(1).click()
    card.locator("#wallet-consent").check()
    card.locator("paypal-button").click()
    return card


def test_late_popup_close_after_approval_neither_cancels_nor_captures_twice(wallet_page):
    page, state = wallet_page
    card = _pay_ten_with(page, "approve-then-cancel")
    page.wait_for_function(
        "() => document.querySelector('.wallet-card')?.textContent.includes('Credits added')"
    )
    page.wait_for_timeout(300)
    assert "Payment cancelled" not in card.inner_text()
    assert state["capture"] == [{"orderId": "ORDER10"}]


def test_popup_closed_after_paying_shows_credits_added_not_cancelled(wallet_page):
    page, state = wallet_page
    card = _pay_ten_with(page, "cancel")
    page.wait_for_function(
        "() => document.querySelector('.wallet-card')?.textContent.includes('Credits added')"
    )
    assert "Payment cancelled" not in card.inner_text()
    assert state["capture"] == [{"orderId": "ORDER10"}]


def test_a_real_cancel_still_says_payment_cancelled(wallet_page):
    page, state = wallet_page
    state["capture_status"] = 409  # PayPal has no approved payment for the order
    card = _pay_ten_with(page, "cancel")
    page.wait_for_function(
        "() => document.querySelector('.wallet-card .wallet-status')?.textContent === 'Payment cancelled.'"
    )
    assert "Credits added" not in card.inner_text()


def test_a_cancel_the_router_cannot_confirm_is_not_called_cancelled(wallet_page):
    page, state = wallet_page
    state["capture_status"] = 502
    card = _pay_ten_with(page, "cancel")
    page.wait_for_function(
        "() => document.querySelector('.wallet-card .wallet-status')?.textContent.includes('before the payment was confirmed')"
    )
    assert "Payment cancelled" not in card.inner_text()


@pytest.mark.parametrize(
    "approve_url", ["javascript:alert(document.domain)", "https://evil.example/checkoutnow"]
)
def test_redirect_fallback_refuses_non_paypal_approve_url(wallet_page, approve_url):
    page, state = wallet_page
    state["client_id"] = None  # no SDK: the picker falls back to the approve-link redirect
    state["approve_url"] = approve_url
    page.set_viewport_size({"width": 1400, "height": 900})
    _open_chat(page)
    _send(page, "summarise the day")
    card = page.locator(".wallet-card")
    card.locator(".wallet-buy").click()
    card.locator(".wallet-pack").nth(0).click()
    card.locator("#wallet-consent").check()
    before = page.url
    card.locator("button.wallet-pay").click()
    page.wait_for_function(
        "() => document.querySelector('.wallet-card .wallet-status')?.textContent.includes('unexpected link')"
    )
    assert page.url == before
    assert len(state["checkout"]) == 1


@pytest.mark.parametrize(
    ("outcome", "reason"),
    [
        ("capped", "this month's limit is reached"),
        ("declined", "could not charge your saved payment method"),
        ("off", "Auto top-up is off."),
    ],
)
def test_402_card_says_why_auto_top_up_did_not_run(wallet_page, outcome, reason):
    page, state = wallet_page
    state["auto_top_up"] = outcome
    page.set_viewport_size({"width": 1400, "height": 900})
    _open_chat(page)
    _send(page, "summarise the day")
    line = page.locator(".wallet-card .wallet-autotopup")
    line.wait_for()
    assert reason in line.inner_text()


def test_402_card_hides_auto_top_up_line_without_an_outcome(wallet_page):
    page, _state = wallet_page
    page.set_viewport_size({"width": 1400, "height": 900})
    _open_chat(page)
    _send(page, "summarise the day")
    page.locator(".wallet-card").wait_for()
    assert page.locator(".wallet-card .wallet-autotopup").is_hidden()


FAKE_CARD_FIELDS_SDK = """
window.__cardFieldsSrc = document.currentScript.src;
window[document.currentScript.dataset.namespace] = {
  CardFields: (handlers) => {
    const field = (name) => () => ({
      render: async (slot) => { slot.textContent = name; },
    });
    return {
      isEligible: () => true,
      NameField: field("name"),
      NumberField: field("number"),
      ExpiryField: field("expiry"),
      CVVField: field("cvv"),
      submit: async () => handlers.onApprove({ orderID: await handlers.createOrder() }),
    };
  },
};
"""


def test_saving_a_card_uses_card_fields_and_turns_auto_top_up_on(wallet_page):
    page, state = wallet_page
    policy_posts = []

    def capture(route, request):
        state["capture"].append(request.post_data_json)
        state["available"] = 10000000
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                {"status": "captured", "paymentIds": ["pay-1"], "savedForAutoTopUp": True}
            ),
        )

    policy = {"enabled": False, "sku": None, "monthlyCapUsdMicros": 0, "savedMethod": None}

    def autotopup(route, request):
        if request.method == "POST":
            body = request.post_data_json
            policy_posts.append(body)
            policy.update(body)
        if state["capture"]:
            policy["savedMethod"] = {"provider": "paypal", "method": "card"}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(policy))

    page.route("**/api/wallet/capture", capture)
    page.route("**/api/wallet/autotopup", autotopup)
    page.route(
        "https://www.sandbox.paypal.com/sdk/js*",
        lambda route, request: route.fulfill(
            status=200, content_type="text/javascript", body=FAKE_CARD_FIELDS_SDK
        ),
    )
    page.set_viewport_size({"width": 1400, "height": 900})
    _open_chat(page)
    _send(page, "summarise the day")
    card = page.locator(".wallet-card")
    card.locator(".wallet-buy").click()
    card.locator(".wallet-pack").nth(1).click()
    card.locator("paypal-button").wait_for()
    card.locator("#wallet-save-autotopup").check()
    submit = card.locator(".wallet-card-fields button.wallet-pay")
    submit.wait_for()
    # The PayPal buttons are gone; Card Fields stay off until the consent is ticked.
    assert card.locator("paypal-button").count() == 0
    assert submit.get_attribute("aria-disabled") == "true"
    submit.dispatch_event("click")
    assert state["checkout"] == []
    card.locator("#wallet-consent").check()
    submit.click()
    page.wait_for_function(
        "() => document.querySelector('.wallet-card')?.textContent.includes('Credits added')"
    )
    assert state["checkout"][0]["paymentSource"] == "card"
    assert state["checkout"][0]["saveForAutoTopUp"] is True
    assert state["capture"] == [{"orderId": "ORDER10"}]
    assert "components=card-fields" in page.evaluate("() => window.__cardFieldsSrc")
    assert "client-id=sandbox-client" in page.evaluate("() => window.__cardFieldsSrc")
    assert policy_posts[0] == {
        "enabled": True,
        "sku": "pack_usd_5",
        "monthlyCapUsdMicros": 25000000,
    }
    page.wait_for_function(
        "() => document.querySelector('.wallet-card')?.textContent.includes('Card saved · auto top-up on, monthly cap $25.00')"
    )
    _shot(page, "wallet-card-saved.png")
    # The account menu shows the saved card with a cap and an off switch.
    page.locator(".product-account summary").click()
    setting = page.locator(".wallet-autotopup-setting")
    page.wait_for_function(
        "() => document.querySelector('.wallet-autotopup-setting')?.textContent.includes('Card saved')"
    )
    page.locator("#autotopup-cap").fill("40")
    page.locator("#autotopup-cap").dispatch_event("change")
    page.wait_for_function(
        "() => document.querySelector('.wallet-autotopup-setting')?.textContent.includes('monthly cap $40.00')"
    )
    assert policy_posts[-1]["monthlyCapUsdMicros"] == 40000000
    page.locator("#autotopup-enabled").uncheck()
    page.wait_for_function(
        "() => document.querySelector('.wallet-autotopup-setting')?.textContent.includes('auto top-up off')"
    )
    assert policy_posts[-1]["enabled"] is False
    assert setting.is_visible()
