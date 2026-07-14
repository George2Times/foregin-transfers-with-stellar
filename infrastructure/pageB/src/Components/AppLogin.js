import React from 'react';
import InputField from './InputField';

// A friendly ID used to be the whole of "logging in" -- type someone else's and
// the app happily showed you their balance and let you spend their money. It's
// a username, so it now comes with a password.
function AppLogin(props){


		return (
            <div className="panel-block is-paddingless is-12" >
                <div className="column is-12" id="token-lists">


                <div className="column has-text-centered">
                Enter Friendly ID:
                </div>

			    <InputField onInputChangeUpdateField={props.onInputChangeUpdateField}
                 fields={props.fields} name="friendlyid" placeholder="Friendly ID"/>

                <div className="column has-text-centered">
                Enter Password:
                </div>

			    <InputField onInputChangeUpdateField={props.onInputChangeUpdateField}
                 fields={props.fields} name="password" type="password" placeholder="Password"/>

			{props.loginerror ?
			<div className="column has-text-centered">
				<span className="tag is-danger">{props.loginerror}</span>
			</div> : ''}

			<div className="column has-text-centered">
			<span className="button is-medium is-warning" onClick={() => props.login()}>
             Log in
			</span >
			</div>
			</div>
			</div>
				)
                    }



export default AppLogin;
