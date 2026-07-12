import React from "react";
import ReactDOM from "react-dom";
import { act } from "react-dom/test-utils";
import AddressBar from "./AddressBar";

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

test("displays the account id and balance passed in via props", () => {
  act(() => {
    ReactDOM.render(
      <AddressBar account="alice*banka.com" balance={1234} />,
      container
    );
  });

  expect(container.textContent).toContain("alice*banka.com");
  expect(container.textContent).toContain("1234");
});

test("renders without crashing when account/balance are not set yet", () => {
  act(() => {
    ReactDOM.render(<AddressBar />, container);
  });

  expect(container.querySelectorAll("p").length).toBe(2);
});
