import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import InputField from "./InputField";

// Note: this project doesn't have @testing-library/react installed, so
// these tests render with plain ReactDOM into a detached container and
// interact with the real DOM node directly.

let container;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  ReactDOM.unmountComponentAtNode(container);
  container.remove();
  container = null;
});

test("renders the placeholder and the current field value", () => {
  act(() => {
    ReactDOM.render(
      <InputField
        name="amount"
        placeholder="Amount (In USD)"
        fields={{ amount: "42" }}
        onInputChangeUpdateField={() => {}}
      />,
      container
    );
  });

  const input = container.querySelector("input");
  expect(input.placeholder).toBe("Amount (In USD)");
  expect(input.defaultValue).toBe("42");
});

test("falls back to an empty value when the field isn't set yet", () => {
  act(() => {
    ReactDOM.render(
      <InputField
        name="amount"
        placeholder="Amount (In USD)"
        fields={{}}
        onInputChangeUpdateField={() => {}}
      />,
      container
    );
  });

  const input = container.querySelector("input");
  expect(input.defaultValue).toBe("");
});

test("reports the field name and new value when the user types", () => {
  const calls = [];
  act(() => {
    ReactDOM.render(
      <InputField
        name="receiver"
        placeholder="Receiver Friendly ID"
        fields={{}}
        onInputChangeUpdateField={(name, value) => calls.push([name, value])}
      />,
      container
    );
  });

  const input = container.querySelector("input");
  act(() => {
    input.value = "bob*bankb.com";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  expect(calls).toEqual([["receiver", "bob*bankb.com"]]);
});

test("renders an addon label when one is provided, and omits it otherwise", () => {
  act(() => {
    ReactDOM.render(
      <InputField
        name="amount"
        placeholder="Amount"
        fields={{}}
        addon="USD"
        onInputChangeUpdateField={() => {}}
      />,
      container
    );
  });
  expect(container.textContent).toContain("USD");

  act(() => {
    ReactDOM.render(
      <InputField
        name="amount"
        placeholder="Amount"
        fields={{}}
        onInputChangeUpdateField={() => {}}
      />,
      container
    );
  });
  expect(container.textContent).not.toContain("USD");
});
