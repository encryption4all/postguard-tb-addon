/// <reference path="../../types/thunderbird.d.ts" />
export {};

interface InitData {
  initialPolicy: Record<string, Array<{ t: string; v: string }>>;
  sign: boolean;
}

const ATTRIBUTE_TYPES = [
  { type: "pbdf.sidn-pbdf.email.email", label: "Email address", hasValue: true },
  { type: "pbdf.sidn-pbdf.mobilenumber.mobilenumber", label: "Mobile number", hasValue: true },
  { type: "pbdf.gemeente.personalData.surname", label: "Surname", hasValue: true },
  { type: "pbdf.gemeente.personalData.dateofbirth", label: "Date of birth", hasValue: true },
  { type: "pbdf.nuts.agb.agbcode", label: "AGB code", hasValue: true },
  { type: "pbdf.pbdf.surfnet-2.id", label: "Surf EduID", hasValue: true },
];

const container = document.getElementById("recipients-container")!;
const btnSave = document.getElementById("btn-save") as HTMLButtonElement;
const btnCancel = document.getElementById("btn-cancel") as HTMLButtonElement;
const pageTitle = document.getElementById("page-title") as HTMLElement;

let initData: InitData | null = null;

async function init() {
  // Request initial data from background
  initData = (await browser.runtime.sendMessage({
    type: "policyEditorInit",
  })) as InitData | null;

  if (!initData) {
    container.innerHTML = '<div class="empty-state">No recipients found.</div>';
    return;
  }

  if (initData.sign) {
    pageTitle.textContent = "PostGuard — Sign";
  }

  renderRecipients(initData.initialPolicy);
}

function renderRecipients(
  policy: Record<string, Array<{ t: string; v: string }>>
) {
  container.innerHTML = "";

  for (const [email, attrs] of Object.entries(policy)) {
    const section = document.createElement("div");
    section.className = "recipient-section";
    section.dataset.email = email;

    const emailLabel = document.createElement("div");
    emailLabel.className = "recipient-email";
    emailLabel.textContent = email;
    section.appendChild(emailLabel);

    const grid = document.createElement("div");
    grid.className = "attr-grid";

    for (const attrType of ATTRIBUTE_TYPES) {
      const existing = attrs.find((a) => a.t === attrType.type);
      const item = document.createElement("label");
      item.className = "attr-item" + (existing ? " selected" : "");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !!existing;
      checkbox.dataset.attrType = attrType.type;

      // Use localized label if available
      const labelText = browser.i18n.getMessage(attrType.type) || attrType.label;
      const label = document.createElement("span");
      label.textContent = labelText;

      const valueContainer = document.createElement("span");
      valueContainer.className = "attr-value";
      const valueInput = document.createElement("input");
      valueInput.type = "text";
      valueInput.placeholder = labelText;
      valueInput.value = existing?.v ?? "";
      valueInput.dataset.attrType = attrType.type;

      valueContainer.appendChild(valueInput);

      checkbox.addEventListener("change", () => {
        item.classList.toggle("selected", checkbox.checked);
        if (checkbox.checked && !valueInput.value) {
          valueInput.focus();
        }
      });

      item.appendChild(checkbox);
      item.appendChild(label);
      item.appendChild(valueContainer);
      grid.appendChild(item);
    }

    section.appendChild(grid);
    container.appendChild(section);
  }
}

function collectPolicy(): Record<string, Array<{ t: string; v: string }>> {
  const policy: Record<string, Array<{ t: string; v: string }>> = {};
  const sections = container.querySelectorAll(".recipient-section");

  for (const section of sections) {
    const email = (section as HTMLElement).dataset.email!;
    const attrs: Array<{ t: string; v: string }> = [];

    const checkboxes = section.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]:checked'
    );

    for (const cb of checkboxes) {
      const type = cb.dataset.attrType!;
      const valueInput = section.querySelector<HTMLInputElement>(
        `input[type="text"][data-attr-type="${type}"]`
      );
      attrs.push({ t: type, v: valueInput?.value ?? "" });
    }

    policy[email] = attrs;
  }

  return policy;
}

btnSave.addEventListener("click", async () => {
  const policy = collectPolicy();
  await browser.runtime.sendMessage({
    type: "policyEditorDone",
    policy,
  });
  window.close();
});

btnCancel.addEventListener("click", () => {
  window.close();
});

init();
