import React from 'react';

function InputField(props) {
    let field = props.name;
    let value = props.fields[field] ? props.fields[field] : '';
    let placeholder = props.placeholder;
    let addon = props.addon;
    // Defaults to a text box; the login form passes type="password" so the
    // password isn't shown on screen as it's typed.
    let type = props.type || 'text';

    let handleChange = e => {
        props.onInputChangeUpdateField(field,e.target.value);
    };

    return (
        <div className="field has-addons is-12">
            <p className="control is-expanded">
                <input defaultValue={props.default || value}
                       onInput={handleChange}
                       placeholder={placeholder} className="input" type={type}></input>
            </p>
            <p className="control">
                {addon ?
                    <a className="button is-static">
                        {addon}
                    </a> :
                    ''}
            </p>
        </div>
    )
}

export default InputField;